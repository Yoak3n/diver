//! 几何与质量阶梯纯逻辑（可单测、无 IO）。

use crate::types::{DisplayInfo, Rect};

/// screenshot 产物硬上限（对齐 Node SHOT_MAX_BYTES，QQ 整屏量级）。
pub const SHOT_MAX_BYTES: u64 = 800 * 1024;

/// 整屏默认最长边。
pub const DEFAULT_MAX_WIDTH: u32 = 1920;

/// 区域默认最长边。
pub const DEFAULT_REGION_MAX_WIDTH: u32 = 1600;

/// 默认 JPEG 质量。
pub const DEFAULT_JPEG_QUALITY: u8 = 68;

/// 按宽度等比缩小（不放大）。返回 (w, h, scaled)。
pub fn scale_to_fit(width: u32, height: u32, max_width: u32) -> (u32, u32, bool) {
    if width <= max_width || width == 0 || max_width == 0 {
        return (width, height, false);
    }
    let ratio = max_width as f64 / width as f64;
    let h = ((height as f64 * ratio).round() as u32).max(1);
    (max_width, h, true)
}

/// JPEG 质量阶梯（超限时逐档降质）。
pub fn jpeg_quality_ladder(preferred: u8) -> Vec<u8> {
    let start = preferred.clamp(1, 100);
    let mut steps = vec![start, 55, 42, 32];
    steps.dedup();
    steps.sort_unstable();
    steps.reverse();
    steps.dedup();
    steps
}

/// 区域与显示器求交；完全在外时返回 None。
pub fn clamp_region_to_display(region: Rect, display: Rect) -> Option<(Rect, bool)> {
    let x1 = region.x.max(display.x);
    let y1 = region.y.max(display.y);
    let x2 = (region.x + region.width as i32).min(display.x + display.width as i32);
    let y2 = (region.y + region.height as i32).min(display.y + display.height as i32);
    if x2 <= x1 || y2 <= y1 {
        return None;
    }
    let clipped = Rect {
        x: x1,
        y: y1,
        width: (x2 - x1) as u32,
        height: (y2 - y1) as u32,
    };
    let was_clipped = clipped != region;
    Some((clipped, was_clipped))
}

/// 点落在哪块屏。
pub fn display_at_point(x: i32, y: i32, displays: &[DisplayInfo]) -> Option<&DisplayInfo> {
    displays.iter().find(|d| {
        x >= d.x && y >= d.y && x < d.x + d.width as i32 && y < d.y + d.height as i32
    })
}

/// 双线性缩放 RGB24（width*height*3 → out_w*out_h*3）。
pub fn scale_rgb_bilinear(src: &[u8], width: u32, height: u32, out_w: u32, out_h: u32) -> Vec<u8> {
    if out_w == width && out_h == height {
        return src.to_vec();
    }
    let mut out = vec![0u8; (out_w * out_h * 3) as usize];
    let x_ratio = if out_w > 1 { (width - 1) as f64 / (out_w - 1) as f64 } else { 0.0 };
    let y_ratio = if out_h > 1 { (height - 1) as f64 / (out_h - 1) as f64 } else { 0.0 };
    for oy in 0..out_h {
        let sy = oy as f64 * y_ratio;
        let y0 = sy.floor() as u32;
        let y1 = (y0 + 1).min(height - 1);
        let fy = sy - y0 as f64;
        for ox in 0..out_w {
            let sx = ox as f64 * x_ratio;
            let x0 = sx.floor() as u32;
            let x1 = (x0 + 1).min(width - 1);
            let fx = sx - x0 as f64;
            for c in 0..3 {
                let i00 = ((y0 * width + x0) * 3 + c) as usize;
                let i10 = ((y0 * width + x1) * 3 + c) as usize;
                let i01 = ((y1 * width + x0) * 3 + c) as usize;
                let i11 = ((y1 * width + x1) * 3 + c) as usize;
                let top = src[i00] as f64 * (1.0 - fx) + src[i10] as f64 * fx;
                let bot = src[i01] as f64 * (1.0 - fx) + src[i11] as f64 * fx;
                let v = top * (1.0 - fy) + bot * fy;
                let idx = ((oy * out_w + ox) * 3 + c) as usize;
                out[idx] = v.round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_caps_width_without_upscale() {
        let (w, h, scaled) = scale_to_fit(2560, 1440, 1920);
        assert_eq!((w, h, scaled), (1920, 1080, true));
        let (w, h, scaled) = scale_to_fit(800, 600, 1920);
        assert_eq!((w, h, scaled), (800, 600, false));
    }

    #[test]
    fn quality_ladder_descends() {
        let ladder = jpeg_quality_ladder(68);
        assert_eq!(ladder[0], 68);
        assert!(ladder.last().unwrap() <= &40);
        assert!(jpeg_quality_ladder(200)[0] == 100);
    }

    #[test]
    fn clamp_rejects_outside_and_clips_overlap() {
        let disp = Rect { x: 2560, y: 0, width: 2560, height: 1440 };
        assert!(clamp_region_to_display(Rect { x: 0, y: 0, width: 10, height: 10 }, disp).is_none());
        let (clipped, was) = clamp_region_to_display(
            Rect { x: 2500, y: 0, width: 100, height: 100 },
            disp,
        )
        .unwrap();
        assert!(was);
        assert_eq!(clipped.x, 2560);
        assert_eq!(clipped.width, 40);
    }

    #[test]
    fn display_at_point_maps_screens() {
        let displays = vec![
            DisplayInfo {
                index: 0,
                name: "A".into(),
                primary: true,
                x: 0,
                y: 0,
                width: 2560,
                height: 1440,
                work: Rect { x: 0, y: 0, width: 2560, height: 1400 },
            },
            DisplayInfo {
                index: 1,
                name: "B".into(),
                primary: false,
                x: 2560,
                y: 0,
                width: 2560,
                height: 1440,
                work: Rect { x: 2560, y: 0, width: 2560, height: 1400 },
            },
        ];
        assert_eq!(display_at_point(10, 10, &displays).unwrap().index, 0);
        assert_eq!(display_at_point(3000, 10, &displays).unwrap().index, 1);
        assert!(display_at_point(-5, -5, &displays).is_none());
    }

    #[test]
    fn bilinear_identity_and_downscale() {
        let src = [10u8, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
        let same = scale_rgb_bilinear(&src, 2, 2, 2, 2);
        assert_eq!(same, src);
        let small = scale_rgb_bilinear(&src, 2, 2, 1, 1);
        assert_eq!(small.len(), 3);
    }
}
