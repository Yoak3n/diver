//! `memory::*` 方法路由：把方法名分发到 `diver-memory` SQLite 存储。

use serde_json::{json, Value};

use super::params::{err, parse_attrs, parse_relations, req_str, to_value};
use crate::services::state::ServiceState;

/// `instance_id`：`X-Diver-Instance` 身份头（P1-2 路由）；无头/未知回退 active 实例。
pub fn dispatch(
    state: &ServiceState,
    instance_id: Option<&str>,
    method: &str,
    params: &Value,
) -> Result<Value, String> {
    let (owner_id, memory) = state.memory.resolve_with_id(instance_id)?;
    let db = memory.lock().map_err(|_| "db lock poisoned".to_string())?;

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
            // shared: true 写共享库（全体实例可读），缺省写本实例私有库（P1-1 双库）。
            db.append_event(
                &req_str(params, "topicId")?,
                &req_str(params, "statement")?,
                i64_opt("ts"),
                str_opt("episodeId"),
                bool_opt("shared").unwrap_or(false),
            )
            .map_err(err)?;
            Value::Null
        }
        "today_events" => to_value(db.today_events().map_err(err)?),
        "recent_episodes" => to_value(db.recent_episodes(i64_opt("days"), usize_opt("limit")).map_err(err)?),
        "get_card" => to_value(db.get_card().map_err(err)?),
        "update_card" => {
            let facts = params.get("facts").unwrap_or(&Value::Null);
            db.update_card(facts).map_err(err)?;
            // 写回式回填（P1-1）：人格卡片是名字权威源，落库后把名字同步回实例清单。
            // 实例身份必须用刚落库那张卡片的归属实例（身份头解析结果），否则会串写
            // 到别的实例的清单项（BUG：实例名被写到 default）。
            if let Some(name) = facts
                .get("name")
                .and_then(|n| n.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                (state.on_card_name)(owner_id.to_string(), name.to_string());
            }
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
        "upsert_entity" => {
            let row = db
                .upsert_entity(&req_str(params, "name")?, str_opt("entityType").as_deref())
                .map_err(err)?;
            to_value(row)
        }
        "set_entity_attr" => {
            let ok = db
                .set_entity_attr(
                    &req_str(params, "entityId")?,
                    &req_str(params, "key")?,
                    &req_str(params, "value")?,
                    str_opt("sourceTopicId").as_deref(),
                )
                .map_err(err)?;
            json!(ok)
        }
        "add_entity_relation" => {
            let ok = db
                .add_entity_relation(
                    &req_str(params, "fromEntityId")?,
                    &req_str(params, "toEntityId")?,
                    &req_str(params, "relation")?,
                    str_opt("sourceTopicId").as_deref(),
                )
                .map_err(err)?;
            json!(ok)
        }
        "upsert_entity_graph" => {
            let attrs = parse_attrs(params.get("attrs"));
            let relations = parse_relations(params.get("relations"));
            let graph = db
                .upsert_entity_graph(
                    &req_str(params, "name")?,
                    str_opt("entityType").as_deref(),
                    &attrs,
                    &relations,
                    str_opt("sourceTopicId").as_deref(),
                )
                .map_err(err)?;
            to_value(graph)
        }
        "find_entity" => to_value(db.find_entity(&req_str(params, "name")?).map_err(err)?),
        "entity_graph" => to_value(
            db.entity_graph(&req_str(params, "name")?, usize_opt("hops"))
                .map_err(err)?,
        ),
        "entity_candidates" => to_value(
            db.entity_candidates(&req_str(params, "text")?, usize_opt("limit"))
                .map_err(err)?,
        ),
        "list_entities" => to_value(db.list_entities(usize_opt("limit")).map_err(err)?),
        "search_entities" => to_value(
            db.search_entities(&req_str(params, "text")?, usize_opt("limit"))
                .map_err(err)?,
        ),
        "stats" => to_value(db.stats().map_err(err)?),
        "snapshot" => to_value(db.snapshot(usize_opt("limit")).map_err(err)?),
        other => return Err(format!("unknown method: {other}")),
    };

    Ok(result)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::dispatch;
    use crate::services::state::{
        CardNameFn, DelegateDispatchFn, MemoryPool, NotifyFn, PresenceDispatchFn, RegistryListFn,
        ServiceState,
    };

    fn temp_pool() -> MemoryPool {
        let mut pool = MemoryPool::new("alpha");
        for id in ["alpha", "beta"] {
            let dir = std::env::temp_dir().join(format!("diver-card-writeback-{id}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let db = diver_memory::db::DualDb::open(&dir.join("private.db"), &dir.join("shared.db"))
                .unwrap();
            pool.insert(id, db);
        }
        pool
    }

    fn state_with(writes: Arc<Mutex<Vec<(String, String)>>>) -> ServiceState {
        let on_card_name: CardNameFn = Arc::new(move |id, name| writes.lock().unwrap().push((id, name)));
        let notify: NotifyFn = Arc::new(|_, _| {});
        let presence: PresenceDispatchFn = Arc::new(|_, _, _| Ok(serde_json::Value::Null));
        let registry: RegistryListFn = Arc::new(|| Ok(serde_json::Value::Null));
        let delegate: DelegateDispatchFn = Arc::new(|_, _, _| Ok(serde_json::Value::Null));
        ServiceState {
            memory: temp_pool(),
            auth_token: "test".into(),
            notify,
            presence_dispatch: presence,
            on_card_name,
            registry_list: registry,
            delegate_dispatch: delegate,
            groups_dir: std::env::temp_dir(),
        }
    }

    /// BUG 回归（实例名串写）：update_card 的名字写回必须路由到卡片实际归属的实例，
    /// 无身份头时回退 active；beta 改名不允许再串写到 alpha（原实现绑死启动时实例）。
    #[test]
    fn card_name_writeback_routes_to_owning_instance() {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let state = state_with(writes.clone());

        dispatch(&state, Some("beta"), "update_card", &serde_json::json!({ "facts": { "name": "小贝" } }))
            .unwrap();
        dispatch(&state, None, "update_card", &serde_json::json!({ "facts": { "name": "小芊" } }))
            .unwrap();

        assert_eq!(
            *writes.lock().unwrap(),
            vec![("beta".to_string(), "小贝".to_string()), ("alpha".to_string(), "小芊".to_string())],
            "写回应带卡片归属实例；无身份头回退 active 实例"
        );
        // 卡片本身落在各自私有库。
        let beta = dispatch(&state, Some("beta"), "get_card", &serde_json::json!({})).unwrap();
        assert_eq!(beta["name"], "小贝");
        let alpha = dispatch(&state, Some("alpha"), "get_card", &serde_json::json!({})).unwrap();
        assert_eq!(alpha["name"], "小芊");
    }
}
