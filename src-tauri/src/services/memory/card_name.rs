//! 壳层卡片名编排入口（设置面板改名 / 清空名字）。

use diver_memory::db::MemoryDb;
use serde_json::json;

use super::params::err;

/// 直接写某实例私有库的人格卡片 name（设置面板改名走这里；空串/缺省 = 不修改）。
///
/// 不经 RPC 分发，故不触发 `on_card_name` 写回——实例清单（回显层）由调用方自己写，
/// 保证「卡片 + 清单」双写在同一处编排。
pub fn set_card_name_at(db_path: &std::path::Path, name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Ok(());
    }
    let db = MemoryDb::open(db_path).map_err(err)?;
    db.update_card(&json!({ "name": name })).map_err(err)
}

/// 清空某实例私有库的人格卡片名字（「清空名字」手动入口专用，见 [`set_card_name_at`]）。
///
/// 与 [`set_card_name_at`] 同属壳层编排入口：不经 RPC 分发、不触发 `on_card_name`
/// 写回，实例清单由调用方同步清空（双写清空）。
pub fn clear_card_name_at(db_path: &std::path::Path) -> Result<(), String> {
    let db = MemoryDb::open(db_path).map_err(err)?;
    db.clear_card_name().map_err(err)
}
