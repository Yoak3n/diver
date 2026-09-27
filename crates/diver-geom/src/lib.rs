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
/// 同屏多宠的横向错位步长（物理像素；单只 600 逻辑宽时约 1/4 体宽）。
pub const PET_POOL_STAGGER: i32 = 160;
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

/// 同屏多宠落点（物理像素）：工作区右下角，按 `slot` **向内**错位，并夹进工作区。
///
/// `work` = 目标显示器工作区 `(x, y, 宽, 高)`；`size` = 窗口物理尺寸。
///
/// 错位必须向内（减 x）：向外加会把已经贴右的窗口推过屏幕边界——右侧还有显示器时
/// 半只宠物就挂在两屏之间，没有显示器时干脆出界（实测 2560 主屏 + 右侧竖屏）。
/// 夹进工作区保证任何一侧都不越界；工作区比窗口还小时贴左上角。
pub fn pet_slot_position(work: (i32, i32, u32, u32), size: (u32, u32), slot: usize) -> (i32, i32) {
    let (wx, wy, ww, wh) = work;
    let (sw, sh) = (size.0 as i32, size.1 as i32);
    let max_x = (wx + ww as i32 - sw).max(wx);
    let max_y = (wy + wh as i32 - sh).max(wy);
    let x = (wx + ww as i32 - sw - PET_DEFAULT_MARGIN - PET_POOL_STAGGER * slot as i32).clamp(wx, max_x);
    let y = (wy + wh as i32 - sh - PET_DEFAULT_MARGIN).clamp(wy, max_y);
    (x, y)
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

    /// 实测布局：主屏 2560×1440 @(0,0)，右侧竖屏接在 x=2560。
    /// 第二只宠物必须仍整个落在主屏内（旧行为：+160 向外 → 2016..2616 跨屏）。
    #[test]
    fn slot_position_stays_inside_work_area() {
        let work = (0, 0, 2560, 1440);
        let size = (600, 560);
        let (x0, y0) = pet_slot_position(work, size, 0);
        assert_eq!((x0, y0), (2560 - 600 - PET_DEFAULT_MARGIN, 1440 - 560 - PET_DEFAULT_MARGIN));
        let (x1, _) = pet_slot_position(work, size, 1);
        assert_eq!(x1, x0 - PET_POOL_STAGGER);
        assert!(x1 + 600 <= 2560, "第二只越出主屏右边界：{}", x1 + 600);
    }

    /// 窗口比工作区还大时贴左上角（不出界、不 panic）。
    #[test]
    fn slot_position_clamps_when_window_larger_than_work_area() {
        assert_eq!(pet_slot_position((100, 50, 400, 300), (600, 560), 0), (100, 50));
        assert_eq!(pet_slot_position((100, 50, 400, 300), (600, 560), 2), (100, 50));
    }

    /// 非零原点的副屏（含负坐标）：错位后仍留在该屏工作区内。
    #[test]
    fn slot_position_handles_offset_work_area() {
        let work = (2560, -424, 1440, 2560);
        let (x, y) = pet_slot_position(work, (600, 560), 2);
        assert!(x >= 2560 && x + 600 <= 2560 + 1440, "x={x}");
        assert!(y >= -424 && y + 560 <= -424 + 2560, "y={y}");
    }
}
