//! 桌宠窗口几何常量与尺寸推导。
//!
//! 独立纯 crate：`config` / `shell` / `core` 同向下依赖，禁止再出现 `config → core`。
//! 与前端 `src/pet/constants.ts` 必须同源：Rust 负责创建/缩放时的窗口尺寸，
//! 前端布局按同一基准换算。两处不一致会导致缩放时互相「打架」。

/// 宠物窗口基准宽度（逻辑像素，100% 档）。Live2D 模型全屏 + 悬浮聊天面板布局。
pub const PET_BASE_WIDTH: f64 = 600.0;
/// 宠物窗口基准高度（逻辑像素，100% 档）。模型高度占比 0.8 → 约 448px。
pub const PET_BASE_HEIGHT: f64 = 560.0;
/// 缩放最小百分比。
pub const PET_SIZE_MIN_PERCENT: f64 = 50.0;
/// 缩放最大百分比。
pub const PET_SIZE_MAX_PERCENT: f64 = 200.0;
/// 未设置时的默认缩放。
pub const PET_SIZE_DEFAULT_PERCENT: f64 = 100.0;
/// 窗口最小宽度：缩得很小时仍保证聊天面板可读。
pub const PET_WINDOW_MIN_WIDTH: f64 = 400.0;
/// 默认贴边边距（工作区右下角）。
pub const PET_DEFAULT_MARGIN: i32 = 24;
/// 拖动后位置写盘的节流（毫秒）。
pub const PET_POSITION_SAVE_DEBOUNCE_MS: u64 = 400;

/// 将百分比收敛进合法区间。
pub fn clamp_size_percent(percent: f64) -> f64 {
    if !percent.is_finite() {
        return PET_SIZE_DEFAULT_PERCENT;
    }
    percent.clamp(PET_SIZE_MIN_PERCENT, PET_SIZE_MAX_PERCENT)
}

/// 由缩放百分比推导桌宠窗口逻辑尺寸。
pub fn pet_window_logical_size(percent: f64) -> (f64, f64) {
    let scale = clamp_size_percent(percent) / 100.0;
    let width = (PET_BASE_WIDTH * scale).max(PET_WINDOW_MIN_WIDTH);
    let height = PET_BASE_HEIGHT * scale;
    (width, height)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_size_scales_with_percent() {
        let (w100, h100) = pet_window_logical_size(100.0);
        assert_eq!((w100, h100), (PET_BASE_WIDTH, PET_BASE_HEIGHT));

        let (w200, h200) = pet_window_logical_size(200.0);
        assert_eq!((w200, h200), (1200.0, 1120.0));

        let (w50, h50) = pet_window_logical_size(50.0);
        // 宽度有下限，高度按比例
        assert_eq!(w50, PET_WINDOW_MIN_WIDTH);
        assert_eq!(h50, 280.0);
    }

    #[test]
    fn percent_clamp() {
        assert_eq!(clamp_size_percent(10.0), PET_SIZE_MIN_PERCENT);
        assert_eq!(clamp_size_percent(999.0), PET_SIZE_MAX_PERCENT);
        assert_eq!(clamp_size_percent(f64::NAN), PET_SIZE_DEFAULT_PERCENT);
    }
}
