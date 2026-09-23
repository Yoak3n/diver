//! L2 ExplorePolicy（设计 §7.4）—— 记忆取词 · 互联网探索。
//!
//! 与 Dream 对称：同属 Solitary，互斥占道（FSM T21 已挡）。
//! 本策略只裁决「要不要探索、探索哪个词」；联网执行在 sidecar memory.explore()。
//!
//! 私有上下文：lastExploreAt / exploredTerms / budget / pendingTerm。

use super::types::ExploreConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExploreReject {
    Cooldown,
    DailyBudget,
    TermRepeat,
    AlreadyActive,
}

impl ExploreReject {
    pub fn as_str(self) -> &'static str {
        match self {
            ExploreReject::Cooldown => "cooldown",
            ExploreReject::DailyBudget => "daily_budget",
            ExploreReject::TermRepeat => "term_repeat",
            ExploreReject::AlreadyActive => "already_active",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ExploreSnapshot {
    pub last_explore_at: u64,
    pub daily_used: u32,
    pub max_per_day: u32,
    pub active: bool,
    pub pending_term: Option<String>,
    pub recent_terms: Vec<String>,
}

use serde::Serialize;

/// 词级冷却记录。
#[derive(Debug, Clone)]
struct TermVisit {
    term: String,
    at: u64,
}

#[derive(Debug, Clone)]
pub struct ExplorePolicy {
    last_explore_at: u64,
    daily_used: u32,
    daily_day: u64,
    active: bool,
    pending_term: Option<String>,
    active_job_id: Option<String>,
    visits: Vec<TermVisit>,
    cfg: ExploreConfig,
}

impl Default for ExplorePolicy {
    fn default() -> Self {
        Self::new(ExploreConfig::default())
    }
}

impl ExplorePolicy {
    pub fn new(cfg: ExploreConfig) -> Self {
        Self {
            last_explore_at: 0,
            daily_used: 0,
            daily_day: 0,
            active: false,
            pending_term: None,
            active_job_id: None,
            visits: Vec::new(),
            cfg,
        }
    }

    pub fn set_config(&mut self, cfg: ExploreConfig) {
        self.cfg = cfg;
    }

    pub fn config(&self) -> ExploreConfig {
        self.cfg
    }

    fn day_stamp(now: u64) -> u64 {
        now / 86_400_000
    }

    fn roll_day(&mut self, now: u64) {
        let day = Self::day_stamp(now);
        if self.daily_day != day {
            self.daily_day = day;
            self.daily_used = 0;
        }
    }

    /// 是否到了该好奇的时刻（长闲；Sleep 更积极）。
    pub fn should_wake(&self, now: u64, idle_ms: u64, sleep: bool) -> bool {
        if self.active {
            return false;
        }
        let need = if sleep {
            self.cfg.idle_ms / 2
        } else {
            self.cfg.idle_ms
        };
        idle_ms >= need
            && (self.last_explore_at == 0 || now.saturating_sub(self.last_explore_at) >= self.cfg.cooldown_ms)
    }

    pub fn veto(&self, term: &str, now: u64) -> Option<ExploreReject> {
        if self.active {
            return Some(ExploreReject::AlreadyActive);
        }
        if self.daily_used >= self.cfg.max_per_day {
            return Some(ExploreReject::DailyBudget);
        }
        if self.last_explore_at > 0 && now.saturating_sub(self.last_explore_at) < self.cfg.cooldown_ms {
            return Some(ExploreReject::Cooldown);
        }
        if self.was_explored(term, now) {
            return Some(ExploreReject::TermRepeat);
        }
        None
    }

    fn was_explored(&self, term: &str, now: u64) -> bool {
        let key = term.trim().to_lowercase();
        self.visits
            .iter()
            .any(|v| v.term == key && now.saturating_sub(v.at) < self.cfg.term_cooldown_ms)
    }

    /// 占坑：成功才记账。`job_id` 由 L3 下发后回写。
    pub fn claim(&mut self, term: &str, now: u64) -> Result<(), ExploreReject> {
        if let Some(reason) = self.veto(term, now) {
            return Err(reason);
        }
        self.roll_day(now);
        self.last_explore_at = now;
        self.daily_used += 1;
        self.active = true;
        self.pending_term = Some(term.trim().to_string());
        self.visits.push(TermVisit {
            term: term.trim().to_lowercase(),
            at: now,
        });
        // 只保留最近 50 次，防膨胀
        if self.visits.len() > 50 {
            let cut = self.visits.len() - 50;
            self.visits.drain(0..cut);
        }
        Ok(())
    }

    pub fn set_job_id(&mut self, job_id: impl Into<String>) {
        self.active_job_id = Some(job_id.into());
    }

    pub fn job_id(&self) -> Option<&str> {
        self.active_job_id.as_deref()
    }

    /// 任务结束 / 取消（USER_CHAT 打断也走这里）。
    pub fn release(&mut self) {
        self.active = false;
        self.pending_term = None;
        self.active_job_id = None;
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn snapshot(&self) -> ExploreSnapshot {
        ExploreSnapshot {
            last_explore_at: self.last_explore_at,
            daily_used: self.daily_used,
            max_per_day: self.cfg.max_per_day,
            active: self.active,
            pending_term: self.pending_term.clone(),
            recent_terms: self.visits.iter().rev().take(8).map(|v| v.term.clone()).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> ExplorePolicy {
        ExplorePolicy::new(ExploreConfig {
            idle_ms: 1_000,
            cooldown_ms: 5_000,
            term_cooldown_ms: 60_000,
            max_per_day: 2,
        })
    }

    #[test]
    fn claim_then_veto_active() {
        let mut e = p();
        assert!(e.claim("MXene", 10_000).is_ok());
        assert!(e.claim("graphene", 11_000).is_err()); // already active
        e.release();
        assert!(e.claim("graphene", 16_000).is_ok()); // 过全局冷却 5s
    }

    #[test]
    fn term_cooldown() {
        let mut e = p();
        assert!(e.claim("MXene", 10_000).is_ok());
        e.release();
        // 16s：过了全局冷却(5s)，但同 term 冷却 60s 未到
        assert_eq!(e.veto("mxene", 16_000), Some(ExploreReject::TermRepeat));
        assert!(e.veto("graphene", 16_000).is_none());
    }

    #[test]
    fn daily_budget() {
        let mut e = p();
        assert!(e.claim("a", 20_000).is_ok());
        e.release();
        assert!(e.claim("b", 30_000).is_ok());
        e.release();
        assert_eq!(e.veto("c", 40_000), Some(ExploreReject::DailyBudget));
    }

    #[test]
    fn should_wake_idle() {
        let e = p();
        assert!(!e.should_wake(0, 500, false));
        assert!(e.should_wake(0, 1_500, false));
        assert!(e.should_wake(0, 600, true));
    }
}
