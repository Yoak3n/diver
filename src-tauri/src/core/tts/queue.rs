//! 播放队列决策（纯逻辑，无 IO / 无 Tauri，便于单测）。

use std::collections::HashMap;

/// 自动朗读去重 TTL（与前端 spoken.ts 同语义）。
pub(super) const SPOKEN_TTL_MS: u64 = 60_000;

/// 朗读去重键：优先消息 id（同一条只读一遍），无 id 回退正文（压空白 + 截 300 字）。
pub(super) fn speech_key(message_id: Option<&str>, text: &str) -> String {
    match message_id {
        Some(id) if !id.trim().is_empty() => format!("msg:{}", id.trim()),
        _ => {
            let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
            format!("text:{}", flat.chars().take(300).collect::<String>())
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Job {
    pub(super) request_id: String,
    pub(super) text: String,
    pub(super) voice: Option<String>,
    /// 每实例音色覆盖（`None` = 跟随全局 TTS 配置）。
    pub(super) tts: Option<crate::config::tts::TtsVoiceOverride>,
}

/// 队列决策（纯逻辑，便于单测）。
#[derive(Debug, Default)]
pub(super) struct QueueState {
    pending: Option<Job>,
    generation: u64,
    drain_running: bool,
    wait_id: Option<String>,
    /// 自动朗读认领记录：去重键 → 认领时刻（跨窗口同一条只读一遍）。
    spoken: HashMap<String, u64>,
}

impl QueueState {
    /// 自动朗读认领：同键在 TTL 内只放行一次。
    ///
    /// 前端 `claimSpeech` 是**每 WebView 独立**的 map，主窗与桌宠同时监听同一
    /// SSE 流时各认领一次、各发一次 tts_speak，同一条会被读两遍——权威认领
    /// 必须落在共享的播放队列（本进程）上。`now_ms` 由调用方注入，便于单测。
    pub(super) fn claim(&mut self, key: &str, now_ms: u64) -> bool {
        self.spoken
            .retain(|_, at| now_ms.saturating_sub(*at) < SPOKEN_TTL_MS);
        if self.spoken.contains_key(key) {
            return false;
        }
        self.spoken.insert(key.to_string(), now_ms);
        true
    }

    /// 入队：force 清待播语义（生成号 +1 打断当前）；默认 latest-wins。
    /// 返回 (generation, 是否需要启动 drain)。
    pub(super) fn enqueue(&mut self, job: Job, force: bool) -> (u64, bool) {
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

    pub(super) fn take_pending(&mut self) -> Option<(Job, u64)> {
        let job = self.pending.take()?;
        Some((job, self.generation))
    }

    pub(super) fn begin_wait(&mut self, request_id: String) {
        self.wait_id = Some(request_id);
    }

    /// 前端播完/打断确认。id 匹配才推进队列。
    pub(super) fn report_end(&mut self, request_id: &str) -> bool {
        if self.wait_id.as_deref() == Some(request_id) {
            self.wait_id = None;
            true
        } else {
            false
        }
    }

    pub(super) fn stop(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        self.wait_id = None;
        self.generation
    }

    pub(super) fn is_stale(&self, gen: u64) -> bool {
        self.generation != gen
    }

    pub(super) fn finish_drain(&mut self) {
        self.drain_running = false;
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
            tts: None,
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

    #[test]
    fn claim_same_key_only_once_within_ttl() {
        let mut q = QueueState::default();
        assert!(q.claim("msg:a", 1_000));
        assert!(!q.claim("msg:a", 2_000));
        assert!(q.claim("msg:b", 2_000));
    }

    #[test]
    fn claim_reexpires_after_ttl() {
        let mut q = QueueState::default();
        assert!(q.claim("msg:a", 1_000));
        assert!(!q.claim("msg:a", 1_000 + SPOKEN_TTL_MS - 1));
        assert!(q.claim("msg:a", 1_000 + SPOKEN_TTL_MS));
    }

    #[test]
    fn speech_key_prefers_message_id() {
        assert_eq!(speech_key(Some("abc"), "hi"), "msg:abc");
        assert_eq!(speech_key(Some("  abc  "), "hi"), "msg:abc");
        assert_eq!(speech_key(Some(""), "hi"), "text:hi");
        assert_eq!(speech_key(None, "  a \n\t b  "), "text:a b");
    }

    #[test]
    fn speech_key_text_fallback_truncates() {
        let long = "字".repeat(400);
        assert_eq!(speech_key(None, &long).chars().count(), "text:".chars().count() + 300);
    }
}
