//! 实例清单纯逻辑：id 生成 / 校验，登记、改名、删除（无 IO，可单测）。

use super::types::{InstanceError, InstanceMeta, InstancesFile, DEFAULT_ID};

/// 校验实例 id：非空、路径安全字符集 `[a-z0-9-]`、不超过 64 字节。
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// 由名称生成 id 骨架：ASCII 小写字母与数字保留，其余折为 `-`；
/// 中文等无 ASCII 可用时兜底 `inst`。
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut pending_sep = false;
    for ch in name.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if out.len() >= 16 {
                break;
            }
            out.push(c);
            pending_sep = false;
        } else if !out.is_empty() && !pending_sep {
            out.push('-');
            pending_sep = true;
        }
    }
    let out = out.trim_end_matches('-');
    if out.is_empty() {
        "inst".to_string()
    } else {
        out.to_string()
    }
}

/// 生成不与 `taken` 冲突的实例 id（骨架被占时追加 `-2`、`-3`…）。
pub fn generate_id(name: &str, taken: &[String]) -> String {
    let base = slugify(name);
    if !taken.iter().any(|t| t == &base) {
        return base;
    }
    for n in 2..u32::MAX {
        let candidate = format!("{base}-{n}");
        if !taken.iter().any(|t| *t == candidate) {
            return candidate;
        }
    }
    base
}

/// 归一化展示名：去首尾空白；空 = 不命名（`None`，之后由人格卡片回填）；
/// 非空时校验 1–32 字符。
fn normalize_name(name: &str) -> Result<Option<String>, InstanceError> {
    let name = name.trim();
    if name.is_empty() {
        return Ok(None);
    }
    if name.chars().count() > 32 {
        return Err(InstanceError::InvalidName);
    }
    Ok(Some(name.to_string()))
}

impl InstancesFile {
    /// 登记新实例：`name` 可选（不命名留空 / `None`），id 自动生成路径安全短 id。
    pub fn create(
        &mut self,
        name: Option<&str>,
        now: u64,
    ) -> Result<InstanceMeta, InstanceError> {
        let name = normalize_name(name.unwrap_or(""))?;
        let taken: Vec<String> = self.instances.iter().map(|i| i.id.clone()).collect();
        let meta = InstanceMeta {
            id: generate_id(name.as_deref().unwrap_or(""), &taken),
            name,
            enabled: true,
            avatar: None,
            created_at: now,
        };
        self.instances.push(meta.clone());
        Ok(meta)
    }

    /// 改名 / 启用开关（id 与登记时间不可变）。
    ///
    /// `name` 语义：`None` 不改；`Some("")` 清空（回到未命名）；`Some(非空)` 改名。
    pub fn update(
        &mut self,
        id: &str,
        name: Option<&str>,
        enabled: Option<bool>,
    ) -> Result<InstanceMeta, InstanceError> {
        let inst = self
            .instances
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or(InstanceError::NotFound)?;
        if let Some(n) = name {
            inst.name = normalize_name(n)?;
        }
        if let Some(e) = enabled {
            inst.enabled = e;
        }
        Ok(inst.clone())
    }

    /// 删除实例（`default` 双保险不可删；数据目录清理随 P1 落地）。
    pub fn remove(&mut self, id: &str) -> Result<(), InstanceError> {
        if id == DEFAULT_ID {
            return Err(InstanceError::ProtectedDefault);
        }
        let before = self.instances.len();
        self.instances.retain(|i| i.id != id);
        if self.instances.len() == before {
            Err(InstanceError::NotFound)
        } else {
            Ok(())
        }
    }

    /// 确保 `default` 在册（missing-default 兜底），缺失时补登记并返回 true。
    ///
    /// 不预命名：名字由用户与其聊天后经人格卡片回填（创建时命名只是可选）。
    pub fn ensure_default(&mut self, now: u64) -> bool {
        if self.instances.iter().any(|i| i.id == DEFAULT_ID) {
            return false;
        }
        self.instances.insert(
            0,
            InstanceMeta {
                id: DEFAULT_ID.to_string(),
                name: None,
                enabled: true,
                avatar: None,
                created_at: now,
            },
        );
        true
    }
}
