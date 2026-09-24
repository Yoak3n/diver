//! 朗读播放队列（latest-wins）+ 合成分发到挂载的播放窗口。
//!
//! 纯队列决策可单测；网络合成走 synth，结果以 `TtsPlayerEvent` 推给
//! pet（优先）或 main 播放器。前端播完 `tts_report_end` 后队列再播下一句。

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::ipc::Channel;

use crate::config::tts::{TtsConfig, TtsProvider};

use super::player_types::{PlayerKind, TtsPlayerEvent};
use super::synth;

const PLAYBACK_WAIT_SECS: u64 = 90;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Job {
    request_id: String,
    text: String,
    voice: Option<String>,
}

/// 队列决策（纯逻辑，便于单测）。
#[derive(Debug, Default)]
pub(crate) struct QueueState {
    pending: Option<Job>,
    generation: u64,
    drain_running: bool,
    wait_id: Option<String>,
}

impl QueueState {
    /// 入队：force 清待播语义（生成号 +1 打断当前）；默认 latest-wins。
    /// 返回 (generation, 是否需要启动 drain)。
    fn enqueue(&mut self, job: Job, force: bool) -> (u64, bool) {
        if force {
            self.generation = self.generation.wrapping_add(1);
            self.wait_id = None;
        }
        self.pending = Some(job);
        let start_drain = !self.drain_running;
        if start_drain {
            self.drain_running = true;
        }
        (self.generation, start_drain)
    }

    fn take_pending(&mut self) -> Option<(Job, u64)> {
        let job = self.pending.take()?;
        Some((job, self.generation))
    }

    fn begin_wait(&mut self, request_id: String) {
        self.wait_id = Some(request_id);
    }

    /// 前端播完/打断确认。id 匹配才推进队列。
    fn report_end(&mut self, request_id: &str) -> bool {
        if self.wait_id.as_deref() == Some(request_id) {
            self.wait_id = None;
            true
        } else {
            false
        }
    }

    fn stop(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        self.wait_id = None;
        self.generation
    }

    fn is_stale(&self, gen: u64) -> bool {
        self.generation != gen
    }

    fn finish_drain(&mut self) {
        self.drain_running = false;
    }
}

struct WaitSlot {
    tx: tokio::sync::oneshot::Sender<()>,
}

#[derive(Default)]
struct Inner {
    pet: Option<Channel<TtsPlayerEvent>>,
    main: Option<Channel<TtsPlayerEvent>>,
    queue: QueueState,
    wait: Option<WaitSlot>,
}

/// 进程级播放队列（core 内单例）。
#[derive(Clone, Default)]
pub struct TtsPlayer(Arc<Mutex<Inner>>);

impl TtsPlayer {
    pub fn global() -> Self {
        use std::sync::OnceLock;
        static P: OnceLock<TtsPlayer> = OnceLock::new();
        P.get_or_init(TtsPlayer::default).clone()
    }

    pub fn attach(&self, kind: PlayerKind, ch: Channel<TtsPlayerEvent>) {
        let mut g = self.0.lock();
        match kind {
            PlayerKind::Pet => g.pet = Some(ch),
            PlayerKind::Main => g.main = Some(ch),
        }
    }

    pub fn detach(&self, kind: PlayerKind) {
        let mut g = self.0.lock();
        match kind {
            PlayerKind::Pet => g.pet = None,
            PlayerKind::Main => g.main = None,
        }
    }

    fn send(&self, ev: &TtsPlayerEvent) {
        let g = self.0.lock();
        let ch = g.pet.as_ref().or(g.main.as_ref());
        if let Some(ch) = ch {
            let _ = ch.send(ev.clone());
        }
    }

    fn is_stale(&self, gen: u64) -> bool {
        self.0.lock().queue.is_stale(gen)
    }

    pub fn report_end(&self, request_id: &str) {
        let mut g = self.0.lock();
        if g.queue.report_end(request_id) {
            if let Some(w) = g.wait.take() {
                let _ = w.tx.send(());
            }
        }
    }

    pub fn stop(&self) {
        {
            let mut g = self.0.lock();
            g.queue.stop();
            if let Some(w) = g.wait.take() {
                let _ = w.tx.send(());
            }
        }
        self.send(&TtsPlayerEvent::Stopped {});
        self.send(&TtsPlayerEvent::Speaking { value: false });
    }

    /// 入队并异步播放。无挂载播放器时返回错误。
    pub fn speak(
        &self,
        cfg: TtsConfig,
        text: String,
        voice: Option<String>,
        force: bool,
    ) -> Result<(), String> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("文本为空".into());
        }
        {
            let g = self.0.lock();
            if g.pet.is_none() && g.main.is_none() {
                return Err("无播放窗口".into());
            }
        }
        let request_id = format!(
            "tts-{}-{:08x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or(0)
        );
        let job = Job {
            request_id,
            text,
            voice,
        };
        let (gen, start_drain) = {
            let mut g = self.0.lock();
            let r = g.queue.enqueue(job, force);
            if force {
                if let Some(w) = g.wait.take() {
                    let _ = w.tx.send(());
                }
            }
            r
        };
        let _ = gen;
        if force {
            self.send(&TtsPlayerEvent::Stopped {});
        }
        if start_drain {
            let this = self.clone();
            tokio::spawn(async move {
                this.drain(cfg).await;
            });
        }
        Ok(())
    }

    async fn drain(&self, cfg: TtsConfig) {
        loop {
            let next = {
                let mut g = self.0.lock();
                match g.queue.take_pending() {
                    Some(pair) => Some(pair),
                    None => {
                        g.queue.finish_drain();
                        None
                    }
                }
            };
            let Some((job, gen)) = next else { return };
            if self.is_stale(gen) {
                continue;
            }
            self.send(&TtsPlayerEvent::Speaking { value: true });
            self.send(&TtsPlayerEvent::Start {
                request_id: job.request_id.clone(),
            });
            let played = self.play_job(&cfg, &job, gen).await;
            self.send(&TtsPlayerEvent::Speaking { value: false });
            if !played {
                self.send(&TtsPlayerEvent::Stopped {});
            }
        }
    }

    /// 合成并推流；成功则等待前端 report_end。
    async fn play_job(&self, cfg: &TtsConfig, job: &Job, gen: u64) -> bool {
        let rid = job.request_id.clone();
        let voice = job
            .voice
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| cfg.voice.trim().to_string());
        if voice.is_empty() {
            log::warn!("[tts] 无声线，跳过");
            return false;
        }

        if cfg.provider == TtsProvider::Mimo {
            let sample_chunks = Arc::new(Mutex::new(0u32));
            let sc = sample_chunks.clone();
            let this = self.clone();
            let rid2 = rid.clone();
            let stream_res = synth::synthesize_mimo_stream(
                cfg,
                &job.text,
                &voice,
                move |b64, done| {
                    if this.is_stale(gen) {
                        return Err("STALE".to_string());
                    }
                    if !done && !b64.is_empty() {
                        *sc.lock() += 1;
                        this.send(&TtsPlayerEvent::Pcm {
                            request_id: rid2.clone(),
                            base64: b64,
                        });
                    }
                    Ok(())
                },
            )
            .await;
            if self.is_stale(gen) {
                return false;
            }
            let n = *sample_chunks.lock();
            if stream_res.is_ok() && n > 0 {
                return self.wait_playback(rid).await;
            }
            match &stream_res {
                Err(e) if e == "STALE" => return false,
                Err(e) => log::warn!("[tts] 流式失败，回退整段: {e}"),
                Ok(_) => {}
            }
        }

        match synth::synthesize(cfg, &job.text, Some(&voice)).await {
            Ok(audio) => {
                if self.is_stale(gen) {
                    return false;
                }
                if audio.base64.is_empty() {
                    log::warn!("[tts] 整段音频为空");
                    return false;
                }
                self.send(&TtsPlayerEvent::Audio {
                    request_id: rid.clone(),
                    base64: audio.base64,
                    mime: audio.mime,
                });
                self.wait_playback(rid).await
            }
            Err(e) => {
                log::warn!("[tts] 合成失败: {e}");
                false
            }
        }
    }

    async fn wait_playback(&self, request_id: String) -> bool {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        {
            let mut g = self.0.lock();
            g.queue.begin_wait(request_id.clone());
            g.wait = Some(WaitSlot { tx });
        }
        self.send(&TtsPlayerEvent::SynthDone {
            request_id: request_id.clone(),
        });
        let done = tokio::time::timeout(Duration::from_secs(PLAYBACK_WAIT_SECS), rx).await;
        {
            let mut g = self.0.lock();
            g.queue.report_end(&request_id);
            g.wait = None;
        }
        matches!(done, Ok(Ok(())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str) -> Job {
        Job {
            request_id: id.into(),
            text: "hi".into(),
            voice: None,
        }
    }

    #[test]
    fn enqueue_latest_wins() {
        let mut q = QueueState::default();
        let (_, start) = q.enqueue(job("a"), false);
        assert!(start);
        let (_, start2) = q.enqueue(job("b"), false);
        assert!(!start2);
        let (taken, _) = q.take_pending().unwrap();
        assert_eq!(taken.request_id, "b");
    }

    #[test]
    fn force_bumps_generation() {
        let mut q = QueueState::default();
        let (g0, _) = q.enqueue(job("a"), false);
        let (g1, _) = q.enqueue(job("b"), true);
        assert_ne!(g0, g1);
        assert!(q.is_stale(g0));
        assert!(!q.is_stale(g1));
    }

    #[test]
    fn report_end_only_matching() {
        let mut q = QueueState::default();
        q.begin_wait("x".into());
        assert!(!q.report_end("y"));
        assert!(q.report_end("x"));
    }

    #[test]
    fn stop_clears_pending() {
        let mut q = QueueState::default();
        q.enqueue(job("a"), false);
        q.stop();
        assert!(q.take_pending().is_none());
    }
}
