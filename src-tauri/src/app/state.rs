use std::sync::Arc;
use parking_lot::Mutex;

use crate::shell::lightweight::{shared_state, LightWeightState};
use crate::shell::pet_mouse::PetMouseStreamState;

/// 壳层 UI 相关状态聚合（状态类型在 shell；app 只持有共享句柄）。
#[derive(Clone)]
pub struct AppState {
    pub lightweight: Arc<Mutex<LightWeightState>>,
    /// 桌宠全局鼠标流（点击穿透恢复）。
    pub pet_mouse: Arc<PetMouseStreamState>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            lightweight: shared_state(),
            pet_mouse: Arc::new(PetMouseStreamState::default()),
        }
    }
}
