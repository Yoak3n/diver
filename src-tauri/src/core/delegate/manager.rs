//! 运行中任务的取消旗标注册表（层内进程级单例：cancel 需跨线程触达监督线程）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub(super) struct Manager {
    running: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Manager {
    pub(super) fn global() -> &'static Manager {
        static MANAGER: OnceLock<Manager> = OnceLock::new();
        MANAGER.get_or_init(|| Manager {
            running: Mutex::new(HashMap::new()),
        })
    }

    pub(super) fn register(&self, id: &str, flag: Arc<AtomicBool>) {
        self.running.lock().unwrap().insert(id.to_string(), flag);
    }

    pub(super) fn remove(&self, id: &str) {
        self.running.lock().unwrap().remove(id);
    }

    pub(super) fn has(&self, id: &str) -> bool {
        self.running.lock().unwrap().contains_key(id)
    }

    pub(super) fn request_cancel(&self, id: &str) -> bool {
        match self.running.lock().unwrap().get(id) {
            Some(flag) => {
                flag.store(true, Ordering::Relaxed);
                true
            }
            None => false,
        }
    }
}

/// 监督线程结束时注销旗标（supervise.rs 经此门面访问）。
pub(crate) fn remove_running(id: &str) {
    Manager::global().remove(id);
}
