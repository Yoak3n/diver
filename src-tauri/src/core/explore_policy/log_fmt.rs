//! ExplorePolicy 日志格式化（纯函数 + 单测；不碰 IO / Tauri）。

use serde_json::Value;

/// 候选词列表一行摘要：`词(0.83, uncertain) · 词2(0.51, recent)`。
pub fn candidates_line(terms: &[Value]) -> String {
    let parts: Vec<String> = terms
        .iter()
        .filter_map(|item| {
            let term = item.get("term").and_then(|v| v.as_str())?.trim();
            if term.is_empty() {
                return None;
            }
            let score = item.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let reason = item.get("reason").and_then(|v| v.as_str()).unwrap_or("?");
            Some(format!("{term}({score:.2}, {reason})"))
        })
        .collect();
    if parts.is_empty() {
        "（无候选）".to_string()
    } else {
        parts.join(" · ")
    }
}

/// 终态 job 摘要：`done pages=3（1 页失败） chars=4521 memoryId=… 耗时=32s`。
pub fn job_summary(state: &str, status: &Value) -> String {
    let mut parts = vec![state.to_string()];
    if let Some(pages) = status.pointer("/result/pages").and_then(|v| v.as_array()) {
        let failed = pages.iter().filter(|p| p.get("error").is_some()).count();
        let mut s = format!("pages={}", pages.len());
        if failed > 0 {
            s.push_str(&format!("（{failed} 页失败）"));
        }
        parts.push(s);
    }
    if let Some(chars) = status.pointer("/result/totalChars").and_then(|v| v.as_u64()) {
        parts.push(format!("chars={chars}"));
    }
    if status
        .pointer("/result/budgetExhausted")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        parts.push("预算耗尽".to_string());
    }
    if let Some(mem) = status.get("memoryId").and_then(|v| v.as_str()) {
        parts.push(format!("memoryId={mem}"));
    }
    if let Some(err) = status.get("error").and_then(|v| v.as_str()) {
        parts.push(format!("error={err}"));
    }
    if let (Some(start), Some(end)) = (
        status.get("startedAt").and_then(|v| v.as_u64()),
        status.get("endedAt").and_then(|v| v.as_u64()),
    ) {
        parts.push(format!("耗时={}s", end.saturating_sub(start) / 1000));
    }
    parts.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn candidates_line_lists_terms() {
        let terms = json!([
            { "term": "MXene", "score": 0.83, "reason": "uncertain" },
            { "term": "  ", "score": 1.0, "reason": "recent" },
            { "term": "学习方向", "score": 0.5, "reason": "high_frequency" },
        ]);
        let line = candidates_line(terms.as_array().unwrap());
        assert_eq!(line, "MXene(0.83, uncertain) · 学习方向(0.50, high_frequency)");
    }

    #[test]
    fn candidates_line_empty_when_no_valid_term() {
        let terms = json!([{ "term": "", "score": 1.0, "reason": "recent" }]);
        assert_eq!(candidates_line(terms.as_array().unwrap()), "（无候选）");
    }

    #[test]
    fn job_summary_full_done() {
        let status = json!({
            "state": "done",
            "startedAt": 1000,
            "endedAt": 33_000,
            "memoryId": "mem-1",
            "result": {
                "totalChars": 4521,
                "budgetExhausted": true,
                "pages": [
                    { "url": "https://a", "excerpt": "…" },
                    { "url": "https://b", "excerpt": "…", "error": "EXTRACT_THIN" },
                ],
            },
        });
        assert_eq!(
            job_summary("done", &status),
            "done pages=2（1 页失败） chars=4521 预算耗尽 memoryId=mem-1 耗时=32s"
        );
    }

    #[test]
    fn job_summary_error_without_result() {
        let status = json!({
            "state": "error",
            "startedAt": 1000,
            "endedAt": 4_000,
            "error": "SEARCH_FAILED: boom",
        });
        assert_eq!(
            job_summary("error", &status),
            "error error=SEARCH_FAILED: boom 耗时=3s"
        );
    }
}
