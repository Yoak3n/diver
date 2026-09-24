//! JPEG 编码：质量阶梯 + 体积硬顶（对齐 QQ 级小产物）。

use std::io::Cursor;

use crate::geometry::jpeg_quality_ladder;
use crate::types::{EncodePlan, ShotError, ShotErrorCode};

/// 将 RGB24 编码为 JPEG，按质量阶梯压到 `plan.max_bytes` 以内。
/// 返回最终字节（未写盘；写盘由 capture 层负责）。
pub fn encode_jpeg_ladder(rgb: &[u8], width: u32, height: u32, plan: EncodePlan) -> Result<Vec<u8>, ShotError> {
    if width == 0 || height == 0 {
        return Err(ShotError::new(ShotErrorCode::InvalidRect, "empty image"));
    }
    let expected = (width as usize) * (height as usize) * 3;
    if rgb.len() < expected {
        return Err(ShotError::new(
            ShotErrorCode::EncodeFailed,
            format!("rgb buffer too small: {} < {expected}", rgb.len()),
        ));
    }
    let qualities = jpeg_quality_ladder(plan.quality);
    let mut last_err: Option<ShotError> = None;
    let mut best: Option<Vec<u8>> = None;
    for q in qualities {
        let mut buf = Cursor::new(Vec::new());
        let encoder = jpeg_encoder::Encoder::new(&mut buf, q);
        let result = encoder.encode(rgb, width as u16, height as u16, jpeg_encoder::ColorType::Rgb);
        if let Err(err) = result {
            last_err = Some(ShotError::new(
                ShotErrorCode::EncodeFailed,
                format!("jpeg encode failed (q={q}): {err}"),
            ));
            continue;
        }
        let bytes = buf.into_inner();
        if bytes.len() as u64 <= plan.max_bytes {
            return Ok(bytes);
        }
        best = Some(bytes);
    }
    if let Some(bytes) = best {
        // 阶梯用尽仍超限：返回最小那次，由 capture 层再缩放重试。
        return Ok(bytes);
    }
    Err(last_err.unwrap_or_else(|| ShotError::new(ShotErrorCode::EncodeFailed, "jpeg encode failed")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid_rgb(w: u32, h: u32) -> Vec<u8> {
        vec![120u8; (w * h * 3) as usize]
    }

    #[test]
    fn encodes_small_solid_under_budget() {
        let plan = EncodePlan {
            max_width: 64,
            quality: 68,
            max_bytes: 50 * 1024,
        };
        let bytes = encode_jpeg_ladder(&solid_rgb(32, 32), 32, 32, plan).unwrap();
        assert!(!bytes.is_empty());
        assert!(bytes.len() as u64 <= plan.max_bytes);
        // JPEG magic
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    }

    #[test]
    fn rejects_empty() {
        let plan = EncodePlan { max_width: 8, quality: 50, max_bytes: 1024 };
        assert!(encode_jpeg_ladder(&[], 0, 0, plan).is_err());
    }

    #[test]
    fn tight_budget_still_returns_jpeg() {
        let plan = EncodePlan {
            max_width: 64,
            quality: 32,
            max_bytes: 1, // 故意不可满足：仍应返回字节供上层再缩
        };
        let bytes = encode_jpeg_ladder(&solid_rgb(16, 16), 16, 16, plan).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    }
}
