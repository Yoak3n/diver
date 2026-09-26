//! 实例清单 CRUD command（壳层元配置）。
//!
//! 只做参数转换与调用 `config::instances`；走 Tauri invoke 而非 backend HTTP——
//! 实例必须在任何 sidecar 存在之前就能定义（启动顺序上壳先行）。

use tauri::{AppHandle, Manager};

use crate::config::instances::{self, InstanceError, InstanceMeta};

/// 列出全部实例（首次访问自动登记 `default`）。
#[tauri::command]
pub fn list_instances(app: AppHandle) -> Vec<InstanceMeta> {
    instances::list_instances(&app)
}

/// 登记新实例：`name` 可选（不命名 → 未命名，由人格卡片回填）；
/// 自动生成路径安全 id，P0 只登记不启动。
///
/// 创建时命名是可选捷径：与设置改名同样双写卡片（权威源），否则名字只在清单层，
/// 会被后到的 `set_name` 回填冲掉，agent 也不知道自己叫什么。
#[tauri::command]
pub fn create_instance(app: AppHandle, name: Option<String>) -> Result<InstanceMeta, String> {
    let meta = instances::create_instance(&app, name.as_deref()).map_err(err_text)?;
    if let Some(new_name) = name.as_deref() {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let paths = crate::config::instances::memory_paths_for(&dir, &meta.id);
        if let Err(err) = crate::services::set_card_name_at(&paths.private, new_name) {
            log::warn!("实例 {} 创建时名字未落到人格卡片：{err}", meta.id);
        }
    }
    Ok(meta)
}

/// 改名 / 启用开关（id 与登记时间不可变；`name` 空串 = 清空回未命名）。
///
/// 改名（非空）双写：人格卡片是名字权威源 → 先写卡片，再写实例清单（回显）；
/// 空串只清清单（卡片 name 空串/缺省为「不修改」语义，没有清空通道）。
#[tauri::command]
pub fn update_instance(
    app: AppHandle,
    id: String,
    name: Option<String>,
    enabled: Option<bool>,
) -> Result<InstanceMeta, String> {
    if let Some(new_name) = name.as_deref() {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let paths = crate::config::instances::memory_paths_for(&dir, &id);
        crate::services::set_card_name_at(&paths.private, new_name)?;
    }
    instances::update_instance(&app, &id, name.as_deref(), enabled).map_err(err_text)
}

/// 删除实例（`default` 双保险不可删；数据目录清理随 P1 落地）。
#[tauri::command]
pub fn delete_instance(app: AppHandle, id: String) -> Result<(), String> {
    instances::delete_instance(&app, &id).map_err(err_text)
}

fn err_text(err: InstanceError) -> String {
    err.to_string()
}
