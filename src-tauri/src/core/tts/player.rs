//! 朗读播放器：合成分发到挂载的播放窗口（队列决策在 queue.rs）。
//!
//! 网络合成走 synth，结果以 `TtsPlayerEvent` 推给 pet（优先）或 main 播放器。
//! 前端播完 `tts_report_end` 后队列再播下一句。

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::ipc::Channel;

use crate::config::tts::{TtsConfig, TtsProvider, TtsVoiceOverride};

use super::player_types::{PlayerKind, TtsPlayerEvent};
use super::queue::{speech_key, Job, QueueState};
use super::synth;

const PLAYBACK_WAIT_SECS: u64 = 90;

/// 当前毫秒时间戳（认领 TTL / request_id 用）。
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
    ///
    /// `tts` 为每实例音色覆盖（`None` = 跟随全局配置）。
    /// `message_id` = 自动朗读的来源消息（去重键；`force` / 手动朗读不去重）。
    pub fn speak(
        &self,
        cfg: TtsConfig,
        text: String,
        voice: Option<String>,
        tts: Option<TtsVoiceOverride>,
        force: bool,
        message_id: Option<String>,
    ) -> Result<(), String> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err("文本为空".into());
        }
        {
            let mut g = self.0.lock();
            if g.pet.is_none() && g.main.is_none() {
                return Err("无播放窗口".into());
            }
            // 自动朗读去重：同一消息只读一遍。前端 claimSpeech 是每 WebView 独立的，
            // 主窗 + 桌宠同开时两边各认领一次、各发一次 speak，同一条会播两遍——
            // 权威认领落在共享队列上（重复到达直接静默丢弃，不入队）。
            if !force {
                let key = speech_key(message_id.as_deref(), &text);
                if !g.queue.claim(&key, now_ms()) {
                    return Ok(());
                }
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
            tts,
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
        // DELIVERING_*：一次 drain 会话首 job 开始 / 队列排空收尾（壳 FSM T09/T09b/T09c）。
        // 自动朗读晚于 busy(false) 落 Ambient，靠 T09c 才能进 Delivering。
        let mut delivering = false;
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
            let Some((job, gen)) = next else {
                if delivering {
                    crate::core::presence::PresenceHandle::active()
                        .apply_event(diver_presence::Event::DeliveringEnd);
                }
                return;
            };
            if self.is_stale(gen) {
                continue;
            }
            if !delivering {
                delivering = true;
                crate::core::presence::PresenceHandle::active()
                    .apply_event(diver_presence::Event::DeliveringStart);
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
        // 每实例音色覆盖：未给的项跟随全局；凭据随生效提供商换槽。
        let eff = cfg.resolve_override(job.tts.as_ref());
        let voice = job
            .voice
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| eff.voice.trim().to_string());
        if voice.is_empty() {
            log::warn!("[tts] 无声线，跳过");
            return false;
        }

        // 流式优先（MiMo / 火山单向流），失败或零分片回退整段合成。
        if matches!(eff.provider, TtsProvider::Mimo | TtsProvider::Volcengine) {
            if self
                .play_streamed(&rid, gen, eff.provider, &eff, &job.text, &voice)
                .await
            {
                return true;
            }
            if self.is_stale(gen) {
                return false;
            }
        }

        match synth::synthesize(&eff, &job.text, Some(&voice)).await {
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

    /// 流式合成并推 PCM 分片；成功听完返回 true，失败/零分片返回 false 供整段回退。
    async fn play_streamed(
        &self,
        rid: &str,
        gen: u64,
        provider: TtsProvider,
        eff: &TtsConfig,
        text: &str,
        voice: &str,
    ) -> bool {
        let sample_chunks = Arc::new(Mutex::new(0u32));
        let sc = sample_chunks.clone();
        let this = self.clone();
        let rid2 = rid.to_string();
        let cb = move |b64: String, done: bool| {
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
        };
        let stream_res = match provider {
            TtsProvider::Mimo => synth::synthesize_mimo_stream(eff, text, voice, cb).await,
            TtsProvider::Volcengine => {
                synth::synthesize_volcengine_stream(eff, text, voice, cb).await
            }
            TtsProvider::Minimax => return false,
        };
        if self.is_stale(gen) {
            return false;
        }
        let n = *sample_chunks.lock();
        if stream_res.is_ok() && n > 0 {
            return self.wait_playback(rid.to_string()).await;
        }
        match &stream_res {
            Err(e) if e == "STALE" => return false,
            Err(e) => log::warn!("[tts] 流式失败，回退整段: {e}"),
            Ok(_) => {}
        }
        false
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
