//! 播放队列决策（纯逻辑，无 IO / 无 Tauri，便于单测）。

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Job {
    pub(super) request_id: String,
    pub(super) text: String,
    pub(super) voice: Option<String>,
}

/// 队列决策（纯逻辑，便于单测）。
#[derive(Debug, Default)]
pub(super) struct QueueState {
    pending: Option<Job>,
    generation: u64,
    drain_running: bool,
    wait_id: Option<String>,
}

impl QueueState {
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
