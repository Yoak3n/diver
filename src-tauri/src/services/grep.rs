//! grep 搜索服务的 RPC handler：把 `grep::search` 方法路由到 `diver-search` 引擎。
//!
//! 与 memory 服务的区别：无状态（不持有 ServiceState 字段），只解析参数并调用
//! diver_search::search。阻塞搜索经 spawn_blocking 跑，避免卡 axum async 线程。

use serde_json::{Value, json};

use diver_search::search::{SearchInput, SearchErrorCode};

/// RPC 失败：code（可选，memory 错误为 None）+ 模型可见 message。
#[derive(Debug)]
pub struct RpcFailure {
    pub code: Option<&'static str>,
    pub message: String,
}

impl RpcFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self { code: None, message: message.into() }
    }

    pub fn coded(code: SearchErrorCode, message: impl Into<String>) -> Self {
        Self { code: Some(code.as_str()), message: message.into() }
    }
}

impl From<diver_search::search::SearchError> for RpcFailure {
    fn from(error: diver_search::search::SearchError) -> Self {
        Self::coded(error.code, error.message)
    }
}

fn req_str(params: &Value, key: &str) -> Result<String, RpcFailure> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| RpcFailure::new(format!("missing param: {key}")))
}

fn usize_opt(params: &Value, key: &str) -> Option<usize> {
    params.get(key).and_then(|v| v.as_u64()).map(|n| n as usize)
}

/// `grep::search`：文件内容搜索。
/// params: { pattern, path, include?, includes?, exclude?, excludes?, maxMatches?|maxCount?, maxBytesPerLine? }
/// include/includes 为 rg glob（支持 `!`、`{a,b}`）；exclude/excludes 自动加 `!` 前缀。
pub fn dispatch(method: &str, params: &Value, workdir: &str) -> Result<Value, RpcFailure> {
    match method {
        "grep::search" => {
            let pattern = req_str(params, "pattern")?;
            let path = req_str(params, "path")?;
            if path.trim().is_empty() {
                return Err(RpcFailure::new("path must be a non-empty string"));
            }
            let mut includes: Vec<String> = Vec::new();
            if let Some(single) = params.get("include").and_then(|v| v.as_str()) {
                if !single.trim().is_empty() {
                    includes.push(single.to_string());
                }
            }
            if let Some(list) = params.get("includes").and_then(|v| v.as_array()) {
                for item in list {
                    if let Some(s) = item.as_str() {
                        if !s.trim().is_empty() {
                            includes.push(s.to_string());
                        }
                    }
                }
            }
            for key in ["exclude", "excludes"] {
                let mut push_neg = |s: &str| {
                    let s = s.trim();
                    if s.is_empty() {
                        return;
                    }
                    includes.push(if s.starts_with('!') { s.to_string() } else { format!("!{s}") });
                };
                if let Some(single) = params.get(key).and_then(|v| v.as_str()) {
                    push_neg(single);
                }
                if let Some(list) = params.get(key).and_then(|v| v.as_array()) {
                    for item in list {
                        if let Some(s) = item.as_str() {
                            push_neg(s);
                        }
                    }
                }
            }
            let input = SearchInput {
                pattern,
                path,
                include: None,
                includes,
                max_matches: usize_opt(params, "maxMatches")
                    .or_else(|| usize_opt(params, "maxCount"))
                    .unwrap_or(250),
                max_bytes_per_line: usize_opt(params, "maxBytesPerLine").unwrap_or(2000),
                workdir: workdir.to_string(),
            };
            let output = diver_search::search::search(&input).map_err(RpcFailure::from)?;
            Ok(json!({
                "matches": output.matches,
                "truncated": output.truncated,
                "totalMatches": output.total_matches,
            }))
        }
        other => Err(RpcFailure::new(format!("unknown method: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmpdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diver-grep-rpc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn search_method_returns_matches() {
        let dir = tmpdir("ok");
        std::fs::write(dir.join("a.txt"), "needle here\nnothing\n").unwrap();
        let params = json!({
            "pattern": "needle",
            "path": dir.to_string_lossy(),
        });
        let out = dispatch("grep::search", &params, &dir.to_string_lossy()).unwrap();
        let matches = out["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["lineNumber"], json!(1));
        assert_eq!(matches[0]["path"], json!("a.txt"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn search_unknown_method_errors() {
        let err = dispatch("grep::foo", &json!({}), ".").unwrap_err();
        assert!(err.code.is_none());
        assert!(err.message.contains("unknown method"));
    }

    #[test]
    fn search_invalid_pattern_has_code() {
        let err = dispatch("grep::search", &json!({ "pattern": "(", "path": "." }), ".").unwrap_err();
        assert_eq!(err.code, Some("INVALID_PATTERN"));
    }

    #[test]
    fn search_missing_target_has_code() {
        let err = dispatch(
            "grep::search",
            &json!({ "pattern": "x", "path": "C:/definitely/not/here" }),
            ".",
        )
        .unwrap_err();
        assert_eq!(err.code, Some("INVALID_TARGET"));
    }

    #[test]
    fn search_missing_params_errors() {
        let err = dispatch("grep::search", &json!({}), ".").unwrap_err();
        assert!(err.message.contains("missing param"));
    }

    #[test]
    fn search_include_and_caps_apply() {
        let dir = tmpdir("caps");
        std::fs::write(dir.join("keep.ts"), "hit\nhit\nhit\n").unwrap();
        std::fs::write(dir.join("skip.js"), "hit\n").unwrap();
        let params = json!({
            "pattern": "hit",
            "path": dir.to_string_lossy(),
            "include": "*.ts",
            "maxMatches": 2,
        });
        let out = dispatch("grep::search", &params, &dir.to_string_lossy()).unwrap();
        assert_eq!(out["matches"].as_array().unwrap().len(), 2);
        assert_eq!(out["truncated"], json!(true));
        assert_eq!(out["totalMatches"], json!(3));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
