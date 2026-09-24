//! Wayland 截屏适配（Linux）。
//!
//! Wayland 禁止任意截屏，正规路径是 **xdg-desktop-portal Screenshot**：
//! 1. D-Bus 调 `org.freedesktop.portal.Screenshot.Screenshot`
//! 2. 等 `Request::Response`，拿到 `file://` URI
//! 3. 解码 PNG → 按 region 裁剪 → 复用 JPEG 小体积编码
//!
//! 列屏：优先 `wl_output`（wayland 协议）；失败时退化为单屏猜测。
//! 不 spawn 外部进程（遵守 crates 禁进程约定）；不链 libwayland C 库。

use std::path::Path;

use crate::encode::encode_jpeg_ladder;
use crate::geometry::{scale_rgb_bilinear, scale_to_fit};
use crate::types::*;

mod outputs;
mod portal;

pub use outputs::list_wayland_outputs;
pub use portal::portal_screenshot_png;

/// 是否处于 Wayland 会话。
pub fn is_wayland() -> bool {
    if std::env::var_os("WAYLAND_DISPLAY").map(|v| !v.is_empty()).unwrap_or(false) {
        return true;
    }
    matches!(
        std::env::var("XDG_SESSION_TYPE").as_deref(),
        Ok("wayland")
    )
}

pub fn list_displays() -> Result<ListDisplaysResult, ShotError> {
    if !is_wayland() {
        return Err(ShotError::new(
            ShotErrorCode::Unsupported,
            "not a Wayland session (set WAYLAND_DISPLAY or use Windows)",
        ));
    }
    match list_wayland_outputs() {
        Ok(list) if !list.displays.is_empty() => Ok(list),
        _ => {
            // 退化：单块未知屏。capture 仍可经 portal 工作；region 用图像坐标。
            Ok(ListDisplaysResult {
                displays: vec![DisplayInfo {
                    index: 0,
                    name: "wayland".into(),
                    primary: true,
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                    work: Rect { x: 0, y: 0, width: 0, height: 0 },
                }],
                virtual_screen: Rect { x: 0, y: 0, width: 0, height: 0 },
            })
        }
    }
}

/// Wayland 无稳定跨合成器的窗口枚举：返回 None（工具层报未找到）。
pub fn find_window(_needle: &str) -> Result<Option<WindowRect>, ShotError> {
    Ok(None)
}

/// portal 全屏 PNG → 裁剪 → JPEG 落盘。
///
/// `rect` 为输出图像坐标（0,0 起）；`rect` 与整图一致时可不裁。
/// 多屏拼合的虚拟坐标由调用方先映射到单图坐标（见 outputs 的 bounds）。
pub fn capture_rect(rect: Rect, plan: EncodePlan, out_path: &str) -> Result<CaptureFileResult, ShotError> {
    if !is_wayland() {
        return Err(ShotError::new(
            ShotErrorCode::Unsupported,
            "not a Wayland session (set WAYLAND_DISPLAY or use Windows)",
        ));
    }
    if rect.width == 0 || rect.height == 0 {
        return Err(ShotError::new(ShotErrorCode::InvalidRect, "invalid capture rect"));
    }

    let png_path = portal_screenshot_png()?;
    let (img_w, img_h, mut rgb) = decode_png_rgb(&png_path)?;

    // rect 越界时裁到图像内；全屏请求 (0,0,0,0) 语义不在此层。
    let crop = match clamp_region_to_display(rect, Rect { x: 0, y: 0, width: img_w, height: img_h }) {
        Some((r, _)) => r,
        None => {
            // 请求区域与 portal 返回图无交集：退回整图，避免静默空图。
            Rect { x: 0, y: 0, width: img_w, height: img_h }
        }
    };
    rgb = crop_rgb(&rgb, img_w, img_h, crop);

    let (tw, th, _) = scale_to_fit(crop.width, crop.height, plan.max_width);
    let mut width = tw;
    let mut height = th;
    if tw != crop.width || th != crop.height {
        rgb = scale_rgb_bilinear(&rgb, crop.width, crop.height, tw, th);
    }
    let mut bytes = encode_jpeg_ladder(&rgb, width, height, plan)?;
    if bytes.len() as u64 > plan.max_bytes {
        let w2 = ((width as f64) * 0.8).floor().max(1.0) as u32;
        let h2 = ((height as f64) * 0.8).floor().max(1.0) as u32;
        rgb = scale_rgb_bilinear(&rgb, width, height, w2, h2);
        width = w2;
        height = h2;
        bytes = encode_jpeg_ladder(&rgb, width, height, plan)?;
    }

    if let Some(parent) = Path::new(out_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ShotError::new(ShotErrorCode::Io, e.to_string()))?;
        }
    }
    std::fs::write(out_path, &bytes).map_err(|e| ShotError::new(ShotErrorCode::Io, e.to_string()))?;

    // 门户临时文件尽量清掉
    let _ = std::fs::remove_file(&png_path);

    Ok(CaptureFileResult {
        path: out_path.to_string(),
        bytes: bytes.len() as u64,
        width,
        height,
        source: crop,
        format: "jpeg".into(),
        quality: plan.quality,
        max_bytes: plan.max_bytes,
    })
}

fn clamp_region_to_display(region: Rect, display: Rect) -> Option<(Rect, bool)> {
    crate::geometry::clamp_region_to_display(region, display)
}

/// 紧凑 RGB24 裁剪。
fn crop_rgb(src: &[u8], width: u32, height: u32, region: Rect) -> Vec<u8> {
    let rw = region.width.min(width.saturating_sub(region.x as u32));
    let rh = region.height.min(height.saturating_sub(region.y as u32));
    if rw == 0 || rh == 0 {
        return src.to_vec();
    }
    let mut out = Vec::with_capacity((rw * rh * 3) as usize);
    for y in 0..rh {
        let sy = region.y as u32 + y;
        let row = ((sy * width + region.x as u32) * 3) as usize;
        let end = row + (rw * 3) as usize;
        if end <= src.len() {
            out.extend_from_slice(&src[row..end]);
        }
    }
    out
}

/// 解码 PNG → (w, h, RGB24)。
fn decode_png_rgb(path: &Path) -> Result<(u32, u32, Vec<u8>), ShotError> {
    let data = std::fs::read(path).map_err(|e| ShotError::new(ShotErrorCode::Io, e.to_string()))?;
    decode_png_rgb_bytes(&data)
}

pub fn decode_png_rgb_bytes(data: &[u8]) -> Result<(u32, u32, Vec<u8>), ShotError> {
    let decoder = png::Decoder::new(std::io::Cursor::new(data));
    let mut reader = decoder
        .read_info()
        .map_err(|e| ShotError::new(ShotErrorCode::CaptureFailed, format!("png header: {e}")))?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| ShotError::new(ShotErrorCode::CaptureFailed, format!("png frame: {e}")))?;
    let width = info.width;
    let height = info.height;
    let rgb = match info.color_type {
        png::ColorType::Rgb => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgba => {
            let src = &buf[..info.buffer_size()];
            let mut out = Vec::with_capacity((width * height * 3) as usize);
            for px in src.chunks_exact(4) {
                out.push(px[0]);
                out.push(px[1]);
                out.push(px[2]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let src = &buf[..info.buffer_size()];
            let mut out = Vec::with_capacity((width * height * 3) as usize);
            for &g in src {
                out.push(g);
                out.push(g);
                out.push(g);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let src = &buf[..info.buffer_size()];
            let mut out = Vec::with_capacity((width * height * 3) as usize);
            for px in src.chunks_exact(2) {
                out.push(px[0]);
                out.push(px[0]);
                out.push(px[0]);
            }
            out
        }
        other => {
            return Err(ShotError::new(
                ShotErrorCode::CaptureFailed,
                format!("unsupported png color type: {other:?}"),
            ))
        }
    };
    Ok((width, height, rgb))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_center() {
        // 2x2 RGB
        let src = [
            1, 2, 3, 4, 5, 6, //
            7, 8, 9, 10, 11, 12,
        ];
        let out = crop_rgb(&src, 2, 2, Rect { x: 1, y: 0, width: 1, height: 2 });
        assert_eq!(out, vec![4, 5, 6, 10, 11, 12]);
    }

    #[test]
    fn decode_minimal_png() {
        // 1x1 红色 PNG（手工构造过重，改用 png crate 编一张）
        let mut buf = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut buf, 1, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[255, 0, 0]).unwrap();
        }
        let (w, h, rgb) = decode_png_rgb_bytes(&buf).unwrap();
        assert_eq!((w, h), (1, 1));
        assert_eq!(rgb, vec![255, 0, 0]);
    }
}
