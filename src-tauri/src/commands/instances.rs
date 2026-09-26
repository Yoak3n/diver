//! 实例清单 CRUD command（壳层元配置）。
//!
//! 只做参数转换与调用 `config::instances`；走 Tauri invoke 而非 backend HTTP——
//! 实例必须在任何 sidecar 存在之前就能定义（启动顺序上壳先行）。

use tauri::AppHandle;

use crate::config::instances::{self, InstanceError, InstanceMeta};

/// 列出全部实例（首次访问自动登记 `default`）。
#[tauri::command]
pub fn list_instances(app: AppHandle) -> Vec<InstanceMeta> {
    instances::list_instances(&app)
}

/// 登记新实例：输入名称，自动生成路径安全 id；P0 只登记不启动。
#[tauri::command]
pub fn create_instance(app: AppHandle, name: String) -> Result<InstanceMeta, String> {
    instances::create_instance(&app, &name).map_err(err_text)
}

/// 改名 / 启用开关（id 与登记时间不可变）。
#[tauri::command]
pub fn update_instance(
    app: AppHandle,
    id: String,
    name: Option<String>,
    enabled: Option<bool>,
) -> Result<InstanceMeta, String> {
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
