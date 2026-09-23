//! 全局鼠标坐标（穿透判定兜底）。

/// 查询全局鼠标在屏幕上的物理坐标。
pub fn cursor_screen_point() -> Option<(i32, i32)> {
    use mouse_position::mouse_position::Mouse;
    match Mouse::get_mouse_position() {
        Mouse::Position { x, y } => Some((x, y)),
        Mouse::Error => None,
    }
}
