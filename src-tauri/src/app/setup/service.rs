//! 本地 RPC 服务装配与启动：能力闭包注入 services（services 不依赖 shell/core）。

use tauri::Manager;

/// 装配并启动本地 services（SQLite 记忆后端等），端口注入 sidecar。
pub(super) fn start_local_services(app: &tauri::AppHandle, instance_id: &str) {
    // 通知 / presence 能力在 app 层包好闭包再注入，services 不依赖 shell/core。
    let notify_app = app.clone();
    let notify: crate::services::NotifyFn = std::sync::Arc::new(move |title, body| {
        crate::shell::notify::show(&notify_app, &title, &body);
    });
    let presence_dispatch: crate::services::PresenceDispatchFn =
        std::sync::Arc::new(|instance, method, params| {
            crate::core::presence::dispatch_rpc(instance, method, params)
        });
    // 记忆双库路径按实例 id 派生（P1-1 双库 + P1-2 身份头路由）：
    // enabled 实例各一份私有库，无身份/未知回退 active 实例。
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| crate::config::config_dir(app));
    let instance_id = instance_id.to_string();
    let mut memory_ids: Vec<String> = crate::config::instances::list_instances(app)
        .into_iter()
        .filter(|i| i.enabled)
        .map(|i| i.id)
        .collect();
    if !memory_ids.contains(&instance_id) {
        memory_ids.push(instance_id.clone());
    }
    let memory_dbs: Vec<(String, crate::config::instances::MemoryPaths)> = memory_ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                crate::config::instances::memory_paths_for(&data_dir, id),
            )
        })
        .collect();
    // 写回式回填：人格卡片名字 → 实例清单 name（权威源 = 卡片）。
    // 实例身份由 services 层按请求身份头解析后传入（首参）——不能绑死启动时
    // active 实例，否则任一实例改名都会串写到 default 的清单项。
    let on_card_name: crate::services::CardNameFn = {
        let app_handle = app.clone();
        std::sync::Arc::new(move |instance_id, name| {
            // 不变量：「清空回未命名」只能由用户在设置面板手动完成；
            // 写回路径永不为空（双保险，与 services 层过滤一起兜住）。
            if name.trim().is_empty() {
                return;
            }
            if let Err(err) = crate::config::instances::update_instance(
                &app_handle,
                &instance_id,
                Some(&name),
                None,
            ) {
                log::warn!("实例名写回失败（{instance_id}）：{err}");
            }
        })
    };
    // P1-2 注册中心查询：registry::list 读注册表文件（P2 消息路由寻址基础）。
    let registry_list: crate::services::RegistryListFn = {
        let dir = crate::config::instances::registry_dir(app);
        std::sync::Arc::new(move || {
            serde_json::to_value(crate::core::instance_registry::list_at(&dir))
                .map_err(|e| e.to_string())
        })
    };
    // 任务委派分发（0.2.0）：监督循环在壳层 core::delegate，闭包注入 services。
    let delegate_dispatch: crate::services::DelegateDispatchFn = {
        let data_dir = data_dir.clone();
        let registry_dir = crate::config::instances::registry_dir(app);
        std::sync::Arc::new(move |instance_id, method, params| {
            let paths = crate::core::delegate::Paths {
                data_dir: data_dir.clone(),
                registry_dir: registry_dir.clone(),
            };
            crate::core::delegate::dispatch_rpc(&paths, instance_id, method, params)
        })
    };
    match crate::services::start(
        app,
        crate::core::sidecar::service_token().to_string(),
        notify,
        presence_dispatch,
        memory_dbs,
        instance_id.clone(),
        on_card_name,
        registry_list,
        delegate_dispatch,
        app.path()
            .app_data_dir()
            .expect("app_data_dir 可用"),
    ) {
        Some(port) => std::env::set_var("DIVER_MEMORY_PORT", port.to_string()),
        None => log::error!("本地服务启动失败，记忆功能不可用"),
    }
    // debug 形态把鉴权令牌落盘供本地脚本（scripts/*.mjs）自动读取；
    // release 不落盘（令牌只活在进程 env / 内存）。
    #[cfg(debug_assertions)]
    {
        if let Ok(dir) = app.path().app_data_dir() {
            match std::fs::write(dir.join("service-token"), crate::core::sidecar::service_token())
            {
                Ok(()) => log::debug!("[init] service-token 已落盘（debug 形态）"),
                Err(e) => log::warn!("[init] service-token 落盘失败: {e}"),
            }
        }
    }
}
