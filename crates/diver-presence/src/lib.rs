//! Diver 陪伴运行时存在感（Companion Presence）—— 纯逻辑 crate。
//!
//! 分层（见 `docs/companion-presence-fsm.md`）：
//! - L0 [`fsm`]：层级状态机，回答「现在是什么相位」
//! - L1 [`capability`]：能力矩阵，回答「该相位允许什么」
//! - L2 [`proactive`]：ProactiveSpeak 策略（原 Idle Gate 语义）
//! - 裁决门面 [`presence::CompanionPresence`]
//!
//! 约束：与 `diver-memory` 相同——**不包含传输层**（HTTP / 进程 / 定时器迁态）。
//! 时间阈值由调用点 `evaluate(now)` / `request(..., now)` 判定后补发显式事件。

pub mod capability;
pub mod explore;
pub mod fsm;
pub mod presence;
pub mod proactive;
pub mod types;

pub use capability::can;
pub use explore::{ExplorePolicy, ExploreReject, ExploreSnapshot};
pub use fsm::{Context as PresenceContext, PresenceFsm};
pub use presence::{CompanionPresence, InjectRequest, PresenceSnapshot};
pub use proactive::{ProactiveSnapshot, ProactiveSpeak, RejectReason};
pub use types::{
    Capability, Event, ExploreConfig, ExploreRequest, Intent, Phase, ProactiveConfig, Regime,
    RequestResult, TimeThresholds, WebExploreReason,
};
