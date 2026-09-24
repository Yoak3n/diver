//! 截图 RPC 适配：`screenshot::*` → `diver-shot` 引擎。
//!
//! 无状态；阻塞 GDI 捕获由 rpc 层 spawn_blocking 调度。

use serde_json::{json, Value};

use diver_shot::{
    capture_rect, find_window, list_displays, EncodePlan, Rect, ShotError, ShotErrorCode,
};

use super::grep::RpcFailure;

fn coded(code: ShotErrorCode, message: impl Into<String>) -> RpcFailure {
    RpcFailure {
        code: Some(code.as_str()),
        message: message.into(),
    }
}

impl From<ShotError> for RpcFailure {
    fn from(error: ShotError) -> Self {
        coded(error.code, error.message)
    }
}

fn req_i32(params: &Value, key: &str) -> Result<i32, RpcFailure> {
    params
        .get(key)
        .and_then(|v| v.as_i64())
        .map(|n| n as i32)
        .ok_or_else(|| RpcFailure::new(format!("missing param: {key}")))
}

fn req_u32(params: &Value, key: &str) -> Result<u32, RpcFailure> {
    params
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as u32)
        .filter(|n| *n > 0)
        .ok_or_else(|| RpcFailure::new(format!("missing/invalid param: {key}")))
}

fn opt_u32(params: &Value, key: &str) -> Option<u32> {
    params.get(key).and_then(|v| v.as_u64()).map(|n| n as u32).filter(|n| *n > 0)
}

fn opt_str(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 分发 `screenshot::list_displays` / `screenshot::window` / `screenshot::capture`。
/// 失败时带 `SHOT_*` 稳定错误 code（经 RpcFailure）。
pub fn dispatch(method: &str, params: &Value) -> Result<Value, RpcFailure> {
    match method {
        "screenshot::list_displays" => {
            let result = list_displays()?;
            Ok(json!({
                "displays": result.displays,
                "virtualScreen": result.virtual_screen,
            }))
        }
        "screenshot::window" => {
            let title = opt_str(params, "title")
                .ok_or_else(|| RpcFailure::new("missing param: title"))?;
            match find_window(&title)? {
                Some(win) => Ok(json!(win)),
                None => Err(coded(
                    ShotErrorCode::WindowNotFound,
                    format!("no visible window matching \"{title}\""),
                )),
            }
        }
        "screenshot::capture" => {
            let x = req_i32(params, "x")?;
            let y = req_i32(params, "y")?;
            let width = req_u32(params, "width")?;
            let height = req_u32(params, "height")?;
            let out_path = opt_str(params, "path")
                .ok_or_else(|| RpcFailure::new("missing param: path"))?;
            let quality = params
                .get("quality")
                .and_then(|v| v.as_u64())
                .map(|q| q.clamp(1, 100) as u8)
                .unwrap_or(68);
            let max_width = opt_u32(params, "maxWidth").unwrap_or(1920);
            let max_bytes = params
                .get("maxBytes")
                .and_then(|v| v.as_u64())
                .unwrap_or(800 * 1024);
            let plan = EncodePlan {
                max_width,
                quality,
                max_bytes,
            };
            let rect = Rect { x, y, width, height };
            let result = capture_rect(rect, plan, &out_path)?;
            Ok(json!({
                "path": result.path,
                "bytes": result.bytes,
                "width": result.width,
                "height": result.height,
                "source": result.source,
                "format": result.format,
                "quality": result.quality,
                "maxBytes": result.max_bytes,
            }))
        }
        other => Err(RpcFailure::new(format!("unknown method: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_method() {
        let err = dispatch("screenshot::nope", &json!({})).unwrap_err();
        assert!(err.message.contains("unknown method"));
    }

    #[test]
    fn capture_requires_path_and_size() {
        let err = dispatch("screenshot::capture", &json!({ "x": 0, "y": 0 })).unwrap_err();
        assert!(err.message.contains("missing"));
    }

    #[test]
    fn window_requires_title() {
        let err = dispatch("screenshot::window", &json!({})).unwrap_err();
        assert!(err.message.contains("title"));
    }
}
