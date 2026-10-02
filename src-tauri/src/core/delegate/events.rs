//! 通道一解析：dsh headless `--json` 事件流（NDJSON）→ 运行摘要。
//!
//! 事件面（`@deepseek-ai/dsh-headless` 的 json-stream 投影）：
//! `session{sessionId,cwd}` / `status{phase,turn,step?,reason?}` /
//! `thinking{text}` / `text{text}` / `tool_call{callId,tool,input}` /
//! `tool_result{callId,status,result}` / `final{text}` / `error{message}`。
//!
//! 全部纯函数：喂行进摘要，字段有界（长流任务内存有界），未知事件容忍跳过。

use std::io::BufRead;

use serde_json::Value;

const MAX_ITEMS: usize = 20;
const TEXT_CAP: usize = 2_000;
const INPUT_CAP: usize = 200;
const FINAL_CAP: usize = 8_000;

/// 一次 `--json` 运行的有界摘要。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct StreamDigest {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    /// 已提交的 assistant 文本（尾部最多 `MAX_ITEMS` 条，逐条截断）。
    pub texts: Vec<String>,
    /// 工具调用「工具名 + 入参摘要」（尾部最多 `MAX_ITEMS` 条）。
    pub tool_calls: Vec<String>,
    /// 终答（无损 `final` 事件，截断到 `FINAL_CAP`）。
    pub final_text: Option<String>,
    /// 启动/解析期错误（`error` 事件）。
    pub error: Option<String>,
    /// 最近一次 `status{phase:turn_end}` 的 reason（失败信号之一）。
    pub turn_end_reason: Option<String>,
    /// 非空 = 流里出现过 `tool_result{status:error}`。
    pub tool_errors: usize,
}

impl StreamDigest {
    pub fn new() -> Self {
        Self::default()
    }

    /// 吸收一行 NDJSON（坏行/未知类型容忍跳过）。
    pub fn absorb(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() {
            return;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "session" => {
                if self.session_id.is_none() {
                    self.session_id = event
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                    self.cwd = event.get("cwd").and_then(Value::as_str).map(str::to_string);
                }
            }
            "status" => {
                if event.get("phase").and_then(Value::as_str) == Some("turn_end") {
                    self.turn_end_reason = Some(render_reason(event.get("reason")));
                }
            }
            "text" => push_bounded(
                &mut self.texts,
                event.get("text").and_then(Value::as_str).unwrap_or(""),
                TEXT_CAP,
            ),
            "tool_call" => {
                let tool = event.get("tool").and_then(Value::as_str).unwrap_or("?");
                let input = render_input(event.get("input"));
                push_bounded(&mut self.tool_calls, &format!("{tool} {input}"), INPUT_CAP + 64);
            }
            "tool_result" => {
                if event.get("status").and_then(Value::as_str) == Some("error") {
                    self.tool_errors += 1;
                }
            }
            "final" => {
                self.final_text = Some(cut(
                    event.get("text").and_then(Value::as_str).unwrap_or(""),
                    FINAL_CAP,
                ))
            }
            "error" => {
                self.error = Some(cut(
                    event.get("message").and_then(Value::as_str).unwrap_or(""),
                    TEXT_CAP,
                ))
            }
            _ => {}
        }
    }
}

/// 逐行吸收一个 NDJSON 读取器。
pub fn digest_from_reader<R: BufRead>(reader: R) -> StreamDigest {
    let mut digest = StreamDigest::new();
    for line in reader.lines().map_while(Result::ok) {
        digest.absorb(&line);
    }
    digest
}

/// `turn_end` 的 reason 实测有两种形态：字符串（"completed"/"interrupted"）或
/// 对象（`{"kind":"error","error":{...,"code":"UNKNOWN_MODEL"}}`）。对象取
/// `kind`，有 error 再拼 code/message——失败信号不留空。
fn render_reason(reason: Option<&Value>) -> String {
    let Some(reason) = reason else { return "end".to_string() };
    if let Some(text) = reason.as_str() {
        return text.to_string();
    }
    if let Some(map) = reason.as_object() {
        let kind = map.get("kind").and_then(Value::as_str).unwrap_or("?");
        if let Some(error) = map.get("error").and_then(Value::as_object) {
            let code = error.get("code").and_then(Value::as_str).unwrap_or("");
            let message = error.get("message").and_then(Value::as_str).unwrap_or("");
            return cut(&format!("{kind}: {code} {message}").trim().to_string(), INPUT_CAP);
        }
        return kind.to_string();
    }
    cut(&reason.to_string(), INPUT_CAP)
}

/// 工具入参的紧凑单行摘要（对象取键值拼接，数组/标量直接截断）。
fn render_input(input: Option<&Value>) -> String {
    let Some(value) = input else { return String::new() };
    let text = match value {
        Value::Object(map) => map
            .iter()
            .map(|(k, v)| {
                let v = match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                format!("{k}={}", cut(&v, INPUT_CAP / 4))
            })
            .collect::<Vec<_>>()
            .join(" "),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    };
    cut(&text, INPUT_CAP)
}

fn push_bounded(items: &mut Vec<String>, text: &str, cap: usize) {
    items.push(cut(text, cap));
    if items.len() > MAX_ITEMS {
        let skip = items.len() - MAX_ITEMS;
        items.drain(..skip);
    }
}

fn cut(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        text.to_string()
    } else {
        text.chars().take(cap).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(lines: &[&str]) -> StreamDigest {
        let mut d = StreamDigest::new();
        for line in lines {
            d.absorb(line);
        }
        d
    }

    #[test]
    fn absorbs_session_texts_tools_and_final() {
        let d = digest(&[
            r#"{"type":"session","sessionId":"session-1","cwd":"/w"}"#,
            r#"{"type":"status","phase":"turn_start","turn":1}"#,
            r#"{"type":"text","text":"干活中"}"#,
            r#"{"type":"tool_call","callId":"c1","tool":"write","input":{"file_path":"/w/a.js","content":"x"}}"#,
            r#"{"type":"tool_result","callId":"c1","status":"error","result":"boom"}"#,
            r#"{"type":"status","phase":"turn_end","turn":1,"reason":"completed"}"#,
            r#"{"type":"final","text":"完成"}"#,
        ]);
        assert_eq!(d.session_id.as_deref(), Some("session-1"));
        assert_eq!(d.cwd.as_deref(), Some("/w"));
        assert_eq!(d.texts, vec!["干活中".to_string()]);
        assert_eq!(d.tool_calls.len(), 1);
        assert!(d.tool_calls[0].starts_with("write "), "{}", d.tool_calls[0]);
        assert!(d.tool_calls[0].contains("file_path=/w/a.js"));
        assert_eq!(d.tool_errors, 1);
        assert_eq!(d.turn_end_reason.as_deref(), Some("completed"));
        assert_eq!(d.final_text.as_deref(), Some("完成"));
    }

    #[test]
    fn renders_object_turn_end_reason() {
        let d = digest(&[
            r#"{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"error","error":{"message":"boom","code":"UNKNOWN_MODEL"}}}"#,
        ]);
        assert_eq!(d.turn_end_reason.as_deref(), Some("error: UNKNOWN_MODEL boom"));
    }

    #[test]
    fn tolerates_bad_lines_and_unknown_types() {
        let d = digest(&[
            "not json at all",
            r#"{"type":"session","sessionId":"s"}"#,
            r#"{"type":"thinking","text":"推理"}"#,
            r#"{"type":"whatever","x":1}"#,
            r#"{"type":"error","message":"boom"}"#,
        ]);
        assert_eq!(d.session_id.as_deref(), Some("s"));
        assert_eq!(d.error.as_deref(), Some("boom"));
    }

    #[test]
    fn bounds_items_and_truncates_text() {
        let mut d = StreamDigest::new();
        for i in 0..30 {
            d.absorb(&format!(r#"{{"type":"text","text":"t{i}"}}"#));
        }
        assert_eq!(d.texts.len(), MAX_ITEMS);
        assert_eq!(d.texts.last().unwrap(), "t29");
        assert!(d.texts.first().unwrap() == "t10");
        d.absorb(r#"{"type":"final","text":"12345678901234567890"}"#);
        let final_text = d.final_text.unwrap();
        assert!(final_text.chars().count() <= 21, "final 截断：{final_text}");
    }

    #[test]
    fn digest_from_reader_parses_multiline() {
        let raw = concat!(
            "{\"type\":\"session\",\"sessionId\":\"s\"}\n",
            "\n",
            "{\"type\":\"final\",\"text\":\"ok\"}\n",
        );
        let d = digest_from_reader(std::io::Cursor::new(raw));
        assert_eq!(d.session_id.as_deref(), Some("s"));
        assert_eq!(d.final_text.as_deref(), Some("ok"));
    }
}
