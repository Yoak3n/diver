//! 委派适配器表（`$COS_HOME/delegate.json`）：agent 名 → 启动命令 + 任务正文通道。
//!
//! 缺省只启用 dsh（自家引擎，本机必有配置）；codex/claude 进表但 disabled——
//! 用户配好 key 后在文件里翻开关即用，零代码。**危险 flag（如
//! `--dangerously-skip-permissions` / `--yolo`）不进缺省表**：工头派的是用户
//! 自己的 agent，权限边界由用户显式编辑本文件决定。

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::{load_at, save_at};

pub const FILE_NAME: &str = "delegate.json";

/// 任务正文通道：`stdin`（命令以 `-` 收尾读标准输入）或 `arg`（argv 中 `{text}` 占位）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextVia {
    Stdin,
    Arg,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAdapter {
    /// 启动命令（argv 逐段，不经 shell 拼接）；`{text}` 占位 = 正文参数位。
    pub argv: Vec<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub text_via: TextVia,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegateConfig {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub agents: std::collections::BTreeMap<String, AgentAdapter>,
}

impl Default for DelegateConfig {
    fn default() -> Self {
        Self {
            schema_version: default_schema_version(),
            agents: Default::default(),
        }
    }
}

fn default_schema_version() -> u32 {
    1
}

/// 出厂适配器表：dsh 首发启用（拍板 2026-09-27）；codex/claude 备位。
fn seeded() -> DelegateConfig {
    let mut agents = std::collections::BTreeMap::new();
    agents.insert(
        "dsh".to_string(),
        AgentAdapter {
            // 首项裸 `dsh` = 启动方式由壳层探测链解析（PATH shim → Harness
            // Desktop → 捆绑 CLI 直启；见 core::delegate::resolve）。
            // 用户把首项换成任何明确启动形式（node+bin.js / pnpm --dir /
            // 绝对路径 shim）即视为显式指定，探测跳过。
            argv: dsh_argv(),
            enabled: true,
            text_via: TextVia::Stdin,
        },
    );
    agents.insert(
        "codex".to_string(),
        AgentAdapter {
            argv: ["codex", "exec", "--json", "{text}"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
            enabled: false,
            text_via: TextVia::Arg,
        },
    );
    agents.insert(
        "claude".to_string(),
        AgentAdapter {
            argv: ["claude", "-p", "{text}"].iter().map(|s| s.to_string()).collect(),
            enabled: false,
            text_via: TextVia::Arg,
        },
    );
    DelegateConfig {
        schema_version: 1,
        agents,
    }
}

/// dsh 首发参数（平台无关：`-` = 从 stdin 读任务正文）。
fn dsh_argv() -> Vec<String> {
    ["dsh", "--profile", "headless", "--json", "-"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// 读取适配器表；缺文件/空表时播种出厂表（幂等）。
pub fn load_or_seed_at(base: &Path) -> DelegateConfig {
    let cfg: DelegateConfig = load_at(base, FILE_NAME);
    if cfg.agents.is_empty() {
        let seed = seeded();
        save_at(base, FILE_NAME, &seed);
        seed
    } else {
        cfg
    }
}

/// 解析可用的适配器（未知名 / 未启用都显式报错，列出可选项）。
pub fn resolve<'a>(cfg: &'a DelegateConfig, agent: &str) -> Result<(String, &'a AgentAdapter), String> {
    let name = if agent.trim().is_empty() { "dsh" } else { agent.trim() };
    let adapter = cfg
        .agents
        .get(name)
        .ok_or_else(|| format!("未知 agent「{name}」，可用：{}", names(&cfg.agents)))?;
    if !adapter.enabled {
        return Err(format!(
            "agent「{name}」未启用（编辑 delegate.json 打开），可用：{}",
            names(&cfg.agents)
        ));
    }
    Ok((name.to_string(), adapter))
}

fn names(agents: &std::collections::BTreeMap<String, AgentAdapter>) -> String {
    agents
        .iter()
        .map(|(name, a)| {
            if a.enabled {
                name.clone()
            } else {
                format!("{name}(未启用)")
            }
        })
        .collect::<Vec<_>>()
        .join("、")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_enables_dsh_only_and_resolves() {
        let cfg = seeded();
        assert!(cfg.agents["dsh"].enabled);
        assert!(!cfg.agents["codex"].enabled);
        assert!(!cfg.agents["claude"].enabled);
        let (name, _) = resolve(&cfg, "").unwrap();
        assert_eq!(name, "dsh", "空 agent 缺省 dsh");
        let (name, _) = resolve(&cfg, "dsh").unwrap();
        assert_eq!(name, "dsh");
        assert!(resolve(&cfg, "codex").unwrap_err().contains("未启用"));
        assert!(resolve(&cfg, "nope").unwrap_err().contains("nope"));
    }

    #[test]
    fn dsh_argv_reads_task_from_stdin() {
        let cfg = seeded();
        assert!(cfg.agents["dsh"].argv.contains(&"-".to_string()));
        assert_eq!(cfg.agents["dsh"].text_via, TextVia::Stdin);
        assert!(cfg.agents["codex"].argv.contains(&"{text}".to_string()));
    }
}
