//! 多实例运行时管理（P1-2）：active manager + 附加实例 manager 集合。
//!
//! 拓扑定案（一壳 + N sidecar 进程）：每实例一个完整 sidecar，各持端口 /
//! COS_HOME / 注册表项。manager 进程级常驻（`Box::leak` 得 `&'static`，
//! 生命周期线程绑定它）；active = 清单第一个 enabled 实例（全停用兜底
//! default），前端 UI 仍只认 active（多实例 UI 随 P2-3）。

use once_cell::sync::OnceCell;
use parking_lot::Mutex;

use super::process::SidecarManager;
use super::status::SidecarState;

/// 附加实例顺序拉起的就绪等待上限（× 100ms）。
const EXTRA_READY_POLLS: u32 = 600;

pub struct Runtimes {
    active: OnceCell<&'static SidecarManager>,
    extras: Mutex<Vec<&'static SidecarManager>>,
}

impl Runtimes {
    pub fn global() -> &'static Self {
        static INSTANCE: OnceCell<Runtimes> = OnceCell::new();
        INSTANCE.get_or_init(|| Runtimes {
            active: OnceCell::new(),
            extras: Mutex::new(Vec::new()),
        })
    }

    /// active 实例 manager（懒构造，等价于旧 `SidecarManager::global()` 单例）。
    pub fn active(&self) -> &'static SidecarManager {
        self.active
            .get_or_init(|| Box::leak(Box::new(SidecarManager::new())))
    }

    /// 登记一个附加实例 manager（进程级常驻，返回 `&'static`）。
    pub fn add_extra(&self, mgr: SidecarManager) -> &'static SidecarManager {
        let leaked: &'static SidecarManager = Box::leak(Box::new(mgr));
        self.extras.lock().push(leaked);
        leaked
    }

    pub fn extras(&self) -> Vec<&'static SidecarManager> {
        self.extras.lock().clone()
    }

    /// `mgr` 是否 active（UI 事件只转发 active 实例的）。
    pub fn is_active(&self, mgr: &SidecarManager) -> bool {
        std::ptr::eq(self.active(), mgr as *const SidecarManager)
    }

    /// 顺序拉起 active 之外的 enabled 实例（全停用时无附加实例）。
    ///
    /// 逐个等就绪再拉下一个：preflight / Node 运行时准备不做并发竞态，
    /// 启动风暴也可控（每实例边际 ~0.35–0.45GB，见多实例互联内存债表）。
    pub fn start_enabled_extras(&self, app: &tauri::AppHandle) {
        let active_id = crate::config::instances::active_instance_id(app);
        for meta in crate::config::instances::list_instances(app)
            .into_iter()
            .filter(|i| i.enabled && i.id != active_id)
        {
            let mgr = SidecarManager::with_port(
                super::ports::pick_free_port().unwrap_or(crate::core::sidecar::DEFAULT_PORT),
            );
            mgr.set_cos_home(crate::config::cos_home_for(app, &meta.id));
            mgr.set_registry_target(crate::core::instance_registry::RegistryTarget {
                dir: crate::config::instances::registry_dir(app),
                id: meta.id.clone(),
                name: meta.name.clone(),
            });
            // preflight / launch 钩子与 active 同源（app 组装期已注入 active）。
            if let Some(hooks) = self.active().hooks.lock().clone() {
                *mgr.hooks.lock() = Some(hooks);
            }
            let mgr = self.add_extra(mgr);
            log::info!(
                "[instances] 拉起附加实例 {}（端口 {}）",
                meta.id,
                mgr.port()
            );
            if !mgr.start(app) {
                log::warn!("[instances] 附加实例 {} 拉起失败", meta.id);
                continue;
            }
            for _ in 0..EXTRA_READY_POLLS {
                if mgr.status().state != SidecarState::Starting {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }

    /// 退出清理：附加实例先停，active 最后。
    pub fn stop_all(&self) {
        for mgr in self.extras() {
            mgr.stop();
        }
        self.active().stop();
    }
}
