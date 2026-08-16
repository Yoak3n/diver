//! memory 服务的 RPC handler：把方法名路由到 `diver-memory` SQLite 存储。

use std::sync::{Arc, Mutex};

use diver_memory::db::MemoryDb;
use serde_json::{json, Value};

pub fn dispatch(db: &Arc<Mutex<MemoryDb>>, method: &str, params: &Value) -> Result<Value, String> {
    let db = db.lock().map_err(|_| "db lock poisoned".to_string())?;

    let str_opt = |key: &str| params.get(key).and_then(|v| v.as_str()).map(str::to_string);
    let i64_opt = |key: &str| params.get(key).and_then(|v| v.as_i64());
    let usize_opt = |key: &str| params.get(key).and_then(|v| v.as_u64()).map(|n| n as usize);
    let bool_opt = |key: &str| params.get(key).and_then(|v| v.as_bool());

    let result = match method {
        "list_topics" => to_value(db.list_topics().map_err(err)?),
        "get_topic" => to_value(db.get_topic(&req_str(params, "id")?).map_err(err)?),
        "create_topic" => {
            let id = db
                .create_topic(
                    &req_str(params, "canonicalName")?,
                    &req_str(params, "stateSummary")?,
                    str_opt("tier").as_deref(),
                    bool_opt("uncertain"),
                )
                .map_err(err)?;
            json!(id)
        }
        "merge_topic" => {
            db.merge_topic(
                &req_str(params, "id")?,
                str_opt("stateSummary").as_deref(),
                str_opt("alias").as_deref(),
                str_opt("action").as_deref(),
            )
            .map_err(err)?;
            Value::Null
        }
        "delete_topic" => {
            db.delete_topic(&req_str(params, "id")?).map_err(err)?;
            Value::Null
        }
        "decay_all" => {
            db.decay_all().map_err(err)?;
            Value::Null
        }
        "activate" => {
            db.activate(&req_str(params, "id")?, None).map_err(err)?;
            Value::Null
        }
        "activate_by_text" => {
            db.activate_by_text(&req_str(params, "text")?).map_err(err)?;
            Value::Null
        }
        "blocking_candidates" => to_value(
            db.blocking_candidates(&req_str(params, "text")?, usize_opt("limit"))
                .map_err(err)?,
        ),
        "demote" => {
            let ok = db.demote(&req_str(params, "id")?, str_opt("reason")).map_err(err)?;
            json!(ok)
        }
        "remember" => {
            let id = db
                .remember(&req_str(params, "content")?, str_opt("topic").as_deref())
                .map_err(err)?;
            json!(id)
        }
        "append_event" => {
            db.append_event(
                &req_str(params, "topicId")?,
                &req_str(params, "statement")?,
                i64_opt("ts"),
                str_opt("episodeId"),
            )
            .map_err(err)?;
            Value::Null
        }
        "today_events" => to_value(db.today_events().map_err(err)?),
        "recent_episodes" => to_value(db.recent_episodes(i64_opt("days"), usize_opt("limit")).map_err(err)?),
        "get_card" => to_value(db.get_card().map_err(err)?),
        "update_card" => {
            db.update_card(params.get("facts").unwrap_or(&Value::Null)).map_err(err)?;
            Value::Null
        }
        "list_promises" => to_value(db.list_promises(str_opt("status").as_deref()).map_err(err)?),
        "upsert_promise" => {
            db.upsert_promise(
                &req_str(params, "content")?,
                str_opt("status").as_deref(),
                i64_opt("dueAt"),
            )
            .map_err(err)?;
            Value::Null
        }
        "append_self_action" => {
            db.append_self_action(
                &req_str(params, "kind")?,
                &req_str(params, "content")?,
                str_opt("topicId").as_deref(),
                i64_opt("ts"),
            )
            .map_err(err)?;
            Value::Null
        }
        "recent_self_actions" => to_value(
            db.recent_self_actions(str_opt("kind").as_deref(), usize_opt("limit")).map_err(err)?,
        ),
        "stats" => to_value(db.stats().map_err(err)?),
        "snapshot" => to_value(db.snapshot().map_err(err)?),
        other => return Err(format!("unknown method: {other}")),
    };

    Ok(result)
}

fn to_value<T: serde::Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn req_str(params: &Value, key: &str) -> Result<String, String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing param: {key}"))
}

fn err(e: diver_memory::Error) -> String {
    e.to_string()
}
