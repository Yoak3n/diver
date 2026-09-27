//! display 编号（index）的唯一规范序。
//!
//! 全项目所有「display N / 屏幕 N」必须指这里的 index：截屏工具 `list_displays`、
//! 壳端 `list_monitors`（桌宠互动事件上下文）共用同一排序，否则事件里引用的
//! 编号会和工具索引对不上（曾因两处枚举顺序相反，事件说 display 1 实为工具 0，
//! 模型连截错两屏）。枚举顺序各平台/各 API 不可依赖，序只能自己定义。

use crate::types::DisplayInfo;

/// 规范化显示器列表：**主屏在前**，再按 (x, y, width, height, name) 稳定排序，
/// 并重编 0..n 的 index。
///
/// 排序键必须是全序（含 name 兜底），保证同一物理显示器集合在任何枚举顺序下
/// 得到完全相同的编号。
pub fn canonicalize_displays(mut displays: Vec<DisplayInfo>) -> Vec<DisplayInfo> {
    displays.sort_by(|a, b| {
        (!a.primary, a.x, a.y, a.width, a.height, &a.name)
            .cmp(&(!b.primary, b.x, b.y, b.width, b.height, &b.name))
    });
    for (i, d) in displays.iter_mut().enumerate() {
        d.index = i as u32;
    }
    displays
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Rect;

    fn display(name: &str, primary: bool, x: i32, y: i32, width: u32, height: u32) -> DisplayInfo {
        DisplayInfo {
            index: 0,
            name: name.into(),
            primary,
            x,
            y,
            width,
            height,
            work: Rect { x, y, width, height },
        }
    }

    /// 用户实际踩坑现场：横屏主屏 + 竖屏副屏，枚举顺序与工具序正好相反。
    #[test]
    fn primary_first_regardless_of_enum_order() {
        let vertical = display(r"\\.\DISPLAY2", false, 2560, 0, 1440, 2560);
        let horizontal = display(r"\\.\DISPLAY1", true, 0, 0, 2560, 1440);

        let from_enum = canonicalize_displays(vec![vertical.clone(), horizontal.clone()]);
        let reversed = canonicalize_displays(vec![horizontal, vertical]);

        assert_eq!(from_enum, reversed, "输入顺序不同，输出编号必须一致");
        assert_eq!(from_enum[0].index, 0);
        assert_eq!(from_enum[0].name, r"\\.\DISPLAY1");
        assert!(from_enum[0].primary, "display 0 必须是主屏（与工具一致）");
        assert_eq!(from_enum[1].index, 1);
        assert_eq!(from_enum[1].height, 2560, "竖屏副屏排在 display 1");
    }

    #[test]
    fn secondary_ordered_left_to_right_then_top_to_bottom() {
        // 序键 (x, y)：先按 x 从左到右，x 相同再按 y 从上到下。
        let right = display("B", false, 2560, 0, 2560, 1440);
        let left = display("A", false, -2560, 0, 2560, 1440);
        let below = display("C", false, 0, 1440, 1920, 1080);
        let list = canonicalize_displays(vec![right, below, left]);
        let names: Vec<&str> = list.iter().map(|d| d.name.as_str()).collect();
        // x: -2560(A) < 0(C) < 2560(B)
        assert_eq!(names, ["A", "C", "B"]);
        assert_eq!(list.iter().map(|d| d.index).collect::<Vec<_>>(), [0, 1, 2]);
    }

    #[test]
    fn identical_geometry_ties_break_by_name() {
        // 镜像/同坐标屏：几何全同也要有确定序。
        let a = display("Z-MIRROR", false, 0, 0, 1920, 1080);
        let b = display("A-MIRROR", false, 0, 0, 1920, 1080);
        let first = canonicalize_displays(vec![a.clone(), b.clone()]);
        let second = canonicalize_displays(vec![b, a]);
        assert_eq!(first, second);
        assert_eq!(first[0].name, "A-MIRROR");
    }

    #[test]
    fn empty_and_single_passthrough() {
        assert!(canonicalize_displays(vec![]).is_empty());
        let one = canonicalize_displays(vec![display("only", false, 0, 0, 800, 600)]);
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].index, 0);
    }
}
