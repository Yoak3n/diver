/**
 * 桌宠窗口几何常量。
 *
 * 与 Rust 侧 `src-tauri/src/base/window/pet_geom.rs` **必须同源**：
 * Rust 负责创建/缩放窗口，前端按同一基准换算布局。两处不一致会在缩放时互相打架。
 */

/** 宠物窗口基准宽度（逻辑像素，100% 档）。 */
export const PET_BASE_WIDTH = 600;

/** 宠物窗口基准高度（逻辑像素，100% 档）。模型高度占比 0.8 → 约 448px。 */
export const PET_BASE_HEIGHT = 560;

/** 缩放最小百分比。 */
export const PET_SIZE_MIN_PERCENT = 50;

/** 缩放最大百分比。 */
export const PET_SIZE_MAX_PERCENT = 200;

/** 未设置时的默认缩放。 */
export const PET_SIZE_DEFAULT_PERCENT = 100;

/** 窗口最小宽度：缩得很小时仍保证聊天面板可读。 */
export const PET_WINDOW_MIN_WIDTH = 400;

/** 模型高度占窗口高度比例（布局内部参数，不随窗口逻辑尺寸公式变化）。 */
export const MODEL_HEIGHT_RATIO = 0.8;

/** 鼠标流事件名（Rust `pet_mouse.rs` emit）。 */
export const PET_MOUSE_MOVE_EVENT = "device-mouse-move";

/** 配置变更事件名。 */
export const PET_WINDOW_CONFIG_EVENT = "pet://window-config";

/** 由缩放百分比推导逻辑窗口尺寸（与 Rust `pet_window_logical_size` 一致）。 */
export function petWindowLogicalSize(percent: number): { width: number; height: number } {
  const p = Number.isFinite(percent) ? percent : PET_SIZE_DEFAULT_PERCENT;
  const clamped = Math.min(PET_SIZE_MAX_PERCENT, Math.max(PET_SIZE_MIN_PERCENT, p));
  const scale = clamped / 100;
  const width = Math.max(PET_BASE_WIDTH * scale, PET_WINDOW_MIN_WIDTH);
  const height = PET_BASE_HEIGHT * scale;
  return { width, height };
}
