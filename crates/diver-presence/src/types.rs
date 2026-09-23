//! Companion Presence 共享类型（L0–L2 对外契约）。
//!
//! 对外相位名保持稳定；节流类字段只出现在 ProactiveSpeak 私有上下文。

use serde::{Deserialize, Serialize};

/// 对外相位 = HSM 叶子名（设计 §3.1 / §3.7）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Off,
    Booting,
    Passive,
    Observing,
    Receptive,
    Listening,
    Thinking,
    Delivering,
    Dreaming,
    Exploring,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Off => "off",
            Phase::Booting => "booting",
            Phase::Passive => "passive",
            Phase::Observing => "observing",
            Phase::Receptive => "receptive",
            Phase::Listening => "listening",
            Phase::Thinking => "thinking",
            Phase::Delivering => "delivering",
            Phase::Dreaming => "dreaming",
            Phase::Exploring => "exploring",
        }
    }
}

/// 正交区 Regime（设计 §3.4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Regime {
    Normal,
    Dnd,
    QuietHours,
    Focus,
    Sleep,
}

impl Regime {
    /// rest 系：压制主动，把 Live 非 Conversation 压进 Resting。
    pub fn is_rest(self) -> bool {
        matches!(
            self,
            Regime::Dnd | Regime::QuietHours | Regime::Focus | Regime::Sleep
        )
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Regime::Normal => "normal",
            Regime::Dnd => "dnd",
            Regime::QuietHours => "quiet_hours",
            Regime::Focus => "focus",
            Regime::Sleep => "sleep",
        }
    }
}

/// L1 能力位（设计 §4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    AcceptUserInput,
    AcceptSteer,
    ProactiveInject,
    AutoTts,
    MemoryDream,
    WebExplore,
    IdleMotion,
    ReactToPet,
}

impl Capability {
    pub fn as_str(self) -> &'static str {
        match self {
            Capability::AcceptUserInput => "accept_user_input",
            Capability::AcceptSteer => "accept_steer",
            Capability::ProactiveInject => "proactive_inject",
            Capability::AutoTts => "auto_tts",
            Capability::MemoryDream => "memory_dream",
            Capability::WebExplore => "web_explore",
            Capability::IdleMotion => "idle_motion",
            Capability::ReactToPet => "react_to_pet",
        }
    }
}

/// L0 事件（设计 §6）。时间类由 `evaluate(now)` 补发，禁止 setTimeout 迁态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Boot,
    Shutdown,
    Enabled(bool),
    Regime(Regime),
    Busy(bool),
    DeliveringStart,
    DeliveringEnd,
    DreamStart,
    DreamEnd,
    ExploreStart,
    ExploreEnd,
    UserChat,
    ChatActivity,
    UserInputStart,
    UserInputEnd,
    PetGesture,
    /// Booting 缓冲结束（EVAL 补发）。
    QuietElapsed,
    /// Ambient 观察静默结束 → Receptive（EVAL 补发）。
    StillElapsed,
}

/// L2 策略意图。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Intent {
    ProactiveInject { source: String, text: String },
    /// 记忆巩固（切片 4 骨架；执行面 dream() 另接）。
    MemoryDream { reason: String, hint: Option<String> },
    /// 互联网探索（§7.4）。
    WebExplore {
        term: String,
        reason: WebExploreReason,
        from_memory_id: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebExploreReason {
    Curiosity,
    LongIdle,
    Sleep,
}

impl WebExploreReason {
    pub fn as_str(self) -> &'static str {
        match self {
            WebExploreReason::Curiosity => "curiosity",
            WebExploreReason::LongIdle => "long_idle",
            WebExploreReason::Sleep => "sleep",
        }
    }
}

/// Explore 私有节流配置（不进 L0 通用上下文）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExploreConfig {
    /// 长闲多久开始好奇（ms）。
    pub idle_ms: u64,
    /// 两次 explore 全局冷却（ms）。
    pub cooldown_ms: u64,
    /// 同一 term 重复探索冷却（ms）。
    pub term_cooldown_ms: u64,
    /// 每日 explore 次数上限。
    pub max_per_day: u32,
}

impl Default for ExploreConfig {
    fn default() -> Self {
        Self {
            idle_ms: 20 * 60_000,
            cooldown_ms: 45 * 60_000,
            term_cooldown_ms: 6 * 3600_000,
            max_per_day: 4,
        }
    }
}

/// L3 待执行探索（裁决通过后交给壳 `POST /api/memory/explore`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExploreRequest {
    pub term: String,
    pub reason: WebExploreReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_memory_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

/// 裁决结果（设计 §8）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestResult {
    Ok { ok: bool },
    Reject {
        ok: bool,
        layer: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        policy: Option<String>,
        reason: String,
    },
}

impl RequestResult {
    pub fn ok() -> Self {
        RequestResult::Ok { ok: true }
    }

    pub fn reject(layer: &'static str, policy: Option<&str>, reason: impl Into<String>) -> Self {
        RequestResult::Reject {
            ok: false,
            layer,
            policy: policy.map(|s| s.to_string()),
            reason: reason.into(),
        }
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, RequestResult::Ok { .. })
    }
}

/// L2 ProactiveSpeak 节流配置（不进 L0 通用上下文）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProactiveConfig {
    pub quiet_ms: u64,
    pub cooldown_ms: u64,
    pub max_triggers: u32,
}

impl Default for ProactiveConfig {
    fn default() -> Self {
        Self {
            quiet_ms: 10_000,
            cooldown_ms: 45_000,
            max_triggers: 1,
        }
    }
}

/// L0 时间阈值（EVAL 用；非 L2 节流）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeThresholds {
    /// Booting 缓冲。
    pub boot_quiet_ms: u64,
    /// Observing → Receptive 的静默时长。
    pub still_ms: u64,
}

impl Default for TimeThresholds {
    fn default() -> Self {
        Self {
            boot_quiet_ms: 2_000,
            still_ms: 8_000,
        }
    }
}

/// 当前 Unix 毫秒（壳可注入测试时钟；本函数仅作缺省）。
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
