//! RPC 参数解析与结果适配纯函数（无 IO）。

use diver_memory::db::RelationSpec;
use serde_json::Value;

/// 解析 attrs 对象 → `(key, value)` 列表（空白值丢弃）。
pub(super) fn parse_attrs(v: Option<&Value>) -> Vec<(String, String)> {
    let Some(Value::Object(map)) = v else {
        return vec![];
    };
    map.iter()
        .filter_map(|(k, val)| {
            val.as_str()
                .map(|s| (k.clone(), s.to_string()))
                .filter(|(_, s)| !s.trim().is_empty())
        })
        .collect()
}

/// 解析 relations 数组 → [`RelationSpec`] 列表（to/relation 必填）。
pub(super) fn parse_relations(v: Option<&Value>) -> Vec<RelationSpec> {
    let Some(Value::Array(items)) = v else {
        return vec![];
    };
    items
        .iter()
        .filter_map(|item| {
            let to_name = item.get("to").and_then(|x| x.as_str())?.trim().to_string();
            let relation = item.get("relation").and_then(|x| x.as_str())?.trim().to_string();
            if to_name.is_empty() || relation.is_empty() {
                return None;
            }
            let to_type = item
                .get("toType")
                .and_then(|x| x.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            Some(RelationSpec {
                to_name,
                relation,
                to_type,
            })
        })
        .collect()
}

/// 必填字符串参数。
pub(super) fn req_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing param: {key}"))
}

/// 序列化结果（失败降级 Null）。
pub(super) fn to_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

/// diver-memory 错误 → IPC 字符串。
pub(super) fn err(e: diver_memory::Error) -> String {
    e.to_string()
}
