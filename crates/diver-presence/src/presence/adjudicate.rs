//! 请求裁决（L1 能力门 + L2 策略记账）。

use super::super::capability;
use super::super::types::{
    Capability, ExploreRequest, Intent, RequestResult, WebExploreReason,
};
use super::{CompanionPresence, InjectRequest};

impl CompanionPresence {
    /// L1 + 全部 L2；成功则策略记账并交出 L3 注入载荷。
    pub fn request(&mut self, intent: Intent, now: u64) -> (RequestResult, Option<InjectRequest>) {
        self.evaluate(now);
        match intent {
            Intent::ProactiveInject { source, text } => {
                let phase = self.fsm.phase();
                if !capability::can(phase, Capability::ProactiveInject) {
                    return (
                        RequestResult::reject(
                            "L1",
                            None,
                            format!("phase {} denies proactive_inject", phase.as_str()),
                        ),
                        None,
                    );
                }
                if let Some(reason) = self.proactive.veto(now) {
                    return (
                        RequestResult::reject("L2", Some("ProactiveSpeak"), reason.as_str()),
                        None,
                    );
                }
                if let Err(reason) = self.proactive.claim(now) {
                    return (
                        RequestResult::reject("L2", Some("ProactiveSpeak"), reason.as_str()),
                        None,
                    );
                }
                let detail = if source == "pet-interaction" {
                    "pet-interaction".to_string()
                } else if source == "presence" {
                    "presence".to_string()
                } else {
                    "proactive".to_string()
                };
                (
                    RequestResult::ok(),
                    Some(InjectRequest {
                        source,
                        text,
                        detail,
                    }),
                )
            }
            Intent::WebExplore {
                term,
                reason,
                from_memory_id,
            } => {
                // 统一走 request_web_explore（注入载荷不适用，返回 None）。
                let (result, _job) =
                    self.request_web_explore(&term, reason, from_memory_id, now);
                (result, None)
            }
            Intent::MemoryDream { reason, hint } => {
                let phase = self.fsm.phase();
                if !capability::can(phase, Capability::MemoryDream) {
                    return (
                        RequestResult::reject(
                            "L1",
                            None,
                            format!("phase {} denies memory_dream", phase.as_str()),
                        ),
                        None,
                    );
                }
                // Dream 执行面未接；先放行裁决但无 L3 注入载荷（壳侧可记日志）。
                let _ = (reason, hint);
                (RequestResult::ok(), None)
            }
        }
    }

    /// WebExplore 专用：裁决 + 记账，交出 L3 探索载荷。
    pub fn request_web_explore(
        &mut self,
        term: &str,
        reason: WebExploreReason,
        from_memory_id: Option<String>,
        now: u64,
    ) -> (RequestResult, Option<ExploreRequest>) {
        self.evaluate(now);
        let phase = self.fsm.phase();
        if !capability::can(phase, Capability::WebExplore) {
            return (
                RequestResult::reject(
                    "L1",
                    None,
                    format!("phase {} denies web_explore", phase.as_str()),
                ),
                None,
            );
        }
        if let Some(r) = self.explore.veto(term, now) {
            return (
                RequestResult::reject("L2", Some("ExplorePolicy"), r.as_str()),
                None,
            );
        }
        if let Err(r) = self.explore.claim(term, now) {
            return (
                RequestResult::reject("L2", Some("ExplorePolicy"), r.as_str()),
                None,
            );
        }
        (
            RequestResult::ok(),
            Some(ExploreRequest {
                term: term.trim().to_string(),
                reason,
                from_memory_id,
                hint: None,
            }),
        )
    }
}
