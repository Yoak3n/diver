//! L2 ProactiveSpeak —— 原 Idle Gate 语义（设计 §7.1）。
//!
//! busy 不在本策略（L0 thinking / L1 已拦）；这里只管 quiet / cooldown / max_triggers。
//! `lastChatAt` 在 BOOT 写 `now`（不是 0），避免真实时钟下启动瞬间误触发。

use super::types::ProactiveConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    RecentChat,
    Cooldown,
    MaxTriggers,
}

impl RejectReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RejectReason::RecentChat => "recent_chat",
            RejectReason::Cooldown => "cooldown",
            RejectReason::MaxTriggers => "max_triggers",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct ProactiveSnapshot {
    pub last_user_chat_at: u64,
    pub last_chat_at: u64,
    pub last_proactive_at: u64,
    pub window_triggers: u32,
    pub quiet_ms: u64,
    pub cooldown_ms: u64,
    pub max_triggers: u32,
}

#[derive(Debug, Clone)]
pub struct ProactiveSpeak {
    last_user_chat_at: u64,
    last_chat_at: u64,
    last_proactive_at: u64,
    window_triggers: u32,
    cfg: ProactiveConfig,
}

impl Default for ProactiveSpeak {
    fn default() -> Self {
        Self::new(ProactiveConfig::default(), 0)
    }
}

impl ProactiveSpeak {
    /// `booted_at`：BOOT 时写入 `lastChatAt`（修 lastChatAt=0 在真实时钟下秒进 ready）。
    pub fn new(cfg: ProactiveConfig, booted_at: u64) -> Self {
        Self {
            last_user_chat_at: 0,
            last_chat_at: booted_at,
            last_proactive_at: 0,
            window_triggers: 0,
            cfg,
        }
    }

    pub fn set_config(&mut self, cfg: ProactiveConfig) {
        self.cfg = cfg;
    }

    pub fn config(&self) -> ProactiveConfig {
        self.cfg
    }

    /// 真人发言：推进静默 + 新闲时窗口。
    pub fn note_user_chat(&mut self, now: u64) {
        self.last_user_chat_at = now;
        self.last_chat_at = now;
        self.window_triggers = 0;
    }

    /// 对话活动（含主动搭话、assistant、turn 边界）：只推进静默。
    pub fn note_chat(&mut self, now: u64) {
        self.last_chat_at = now;
    }

    pub fn veto(&self, now: u64) -> Option<RejectReason> {
        if now.saturating_sub(self.last_chat_at) < self.cfg.quiet_ms {
            return Some(RejectReason::RecentChat);
        }
        if self.last_proactive_at > 0
            && now.saturating_sub(self.last_proactive_at) < self.cfg.cooldown_ms
        {
            return Some(RejectReason::Cooldown);
        }
        if self.window_triggers >= self.cfg.max_triggers {
            return Some(RejectReason::MaxTriggers);
        }
        None
    }

    /// 占坑：成功才记账。`note_chat` 由 L3 注入成功后调用，避免与冷却判定纠缠。
    pub fn claim(&mut self, now: u64) -> Result<(), RejectReason> {
        if let Some(reason) = self.veto(now) {
            return Err(reason);
        }
        self.last_proactive_at = now;
        self.window_triggers += 1;
        Ok(())
    }

    pub fn snapshot(&self) -> ProactiveSnapshot {
        ProactiveSnapshot {
            last_user_chat_at: self.last_user_chat_at,
            last_chat_at: self.last_chat_at,
            last_proactive_at: self.last_proactive_at,
            window_triggers: self.window_triggers,
            quiet_ms: self.cfg.quiet_ms,
            cooldown_ms: self.cfg.cooldown_ms,
            max_triggers: self.cfg.max_triggers,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gate(boot: u64) -> ProactiveSpeak {
        ProactiveSpeak::new(
            ProactiveConfig {
                quiet_ms: 1_000,
                cooldown_ms: 5_000,
                max_triggers: 1,
            },
            boot,
        )
    }

    #[test]
    fn boot_writes_last_chat_at_now() {
        let g = gate(10_000);
        assert_eq!(
            g.veto(10_000),
            Some(RejectReason::RecentChat),
            "BOOT 必须把 lastChatAt 写成 now"
        );
        assert_eq!(g.veto(11_100), None);
    }

    #[test]
    fn quiet_cooldown_quota() {
        let mut g = gate(0);
        assert_eq!(g.veto(500), Some(RejectReason::RecentChat));
        assert_eq!(g.veto(1_200), None);
        assert!(g.claim(1_200).is_ok());
        assert_eq!(g.veto(1_500), Some(RejectReason::Cooldown));
        assert_eq!(g.veto(7_000), Some(RejectReason::MaxTriggers));
    }

    #[test]
    fn user_chat_resets_window() {
        let mut g = gate(0);
        assert!(g.claim(1_200).is_ok());
        g.note_user_chat(2_000);
        assert_eq!(g.veto(2_500), Some(RejectReason::RecentChat));
        // 仍受上次 proactive 冷却约束（与原 Idle Gate 一致）
        assert_eq!(g.veto(3_100), Some(RejectReason::Cooldown));
        assert_eq!(g.veto(6_300), None);
        assert!(g.claim(6_300).is_ok());
    }

    #[test]
    fn note_chat_does_not_reset_window() {
        let mut g = gate(0);
        assert!(g.claim(1_200).is_ok());
        g.note_chat(2_000);
        // 仍在 quota 窗口内（冷却先到）
        assert_eq!(g.veto(2_500), Some(RejectReason::RecentChat));
        assert_eq!(g.veto(3_000), Some(RejectReason::Cooldown));
        assert_eq!(g.veto(7_000), Some(RejectReason::MaxTriggers));
    }
}
