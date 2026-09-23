use std::sync::Arc;
use parking_lot::Mutex;

use crate::shell::lightweight::LightWeightState;
use crate::shell::pet_mouse::PetMouseStreamState;

#[derive(Clone)]
pub struct AppState {
    pub lightweight: Arc<Mutex<LightWeightState>>,
    /// 桌宠全局鼠标流（点击穿透恢复）。
    pub pet_mouse: Arc<PetMouseStreamState>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            lightweight: Arc::new(Mutex::new(LightWeightState::default())),
            pet_mouse: Arc::new(PetMouseStreamState::default()),
        }
    }
}