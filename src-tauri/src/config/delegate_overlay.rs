//! dsh 委派 overlay（`$COS_HOME/dsh-delegate-overlay.yml`）：派单进程的模型路由补丁。
//!
//! headless 档案没有 `--provider` 旗标，provider 走配置面 `agent-default-model`；
//! 本 overlay 经 `--patch` 附加到派单 argv，做到两件事（拍板 2026-09-29）：
//! 1. provider/model 由环境变量直选（`DSH_DELEGATE_PROVIDER` / `DSH_DELEGATE_MODEL`），
//!    工头派单可按任务指定；缺省走用户自己的 ark 渠道；
//! 2. 整只禁用 `deepseek-account`——**不触碰 DeepSeek 官方 API**（除非用户显式改本文件）。
//!
//! 首次播种后归用户所有：之后**永不覆写**，改坏了删文件即可重新播种。

use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "dsh-delegate-overlay.yml";

/// `$COS_HOME/dsh-delegate-overlay.yml` 的完整路径。
pub fn path_at(base: &Path) -> PathBuf {
    base.join(FILE_NAME)
}

/// 确保 overlay 存在（缺文件才播种，返回完整路径）。
pub fn ensure_at(base: &Path) -> PathBuf {
    let path = path_at(base);
    if !path.exists() {
        let _ = std::fs::write(&path, template());
    }
    path
}

/// 出厂 overlay 模板：ark 提供方（凭据走 credentials 的 ref）+ 环境变量直选 + 禁 deepseek 账号。
pub fn template() -> &'static str {
    r#"# dsh 委派 overlay（diver 播种；改坏删掉即重新生成）：
# - provider/model 由环境变量直选：DSH_DELEGATE_PROVIDER / DSH_DELEGATE_MODEL
# - 整只禁用 deepseek-account，派单进程不触碰 DeepSeek 官方 API
# 用法：dsh --profile headless --patch <本文件> --json -
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      ark-agent-plan-cn:
        displayName: Ark Agent Plan
        apiKeyEnv: ARK_AGENT_PLAN_CN_API_KEY
        api: anthropic-messages
        baseURL: https://ark.cn-beijing.volces.com/api/plan
        models:
          - id: doubao-seed-2.1-pro
            name: Doubao Seed 2.1 Pro (Agent Plan)
            contextWindow: 256000
            maxTokens: 256000
            input:
              - text
              - image
          - id: doubao-seed-2.1-turbo
            name: Doubao Seed 2.1 Turbo (Agent Plan)
            contextWindow: 256000
            maxTokens: 256000
            input:
              - text
              - image
          - id: doubao-seed-evolving
            name: Doubao Seed Evolving (Agent Plan)
            contextWindow: 1024000
            maxTokens: 256000
            input:
              - text
              - image
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: !!js process.env.DSH_DELEGATE_PROVIDER || 'ark-agent-plan-cn'
    model: !!js process.env.DSH_DELEGATE_MODEL || 'doubao-seed-2.1-pro'
- id: deepseek-account
  disabled: true
"#
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diver-overlay-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ensure_seeds_once_and_never_overwrites() {
        let base = temp_base("seed");
        let path = ensure_at(&base);
        assert!(path.exists());
        std::fs::write(&path, "# 用户改过\n").unwrap();
        ensure_at(&base);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# 用户改过\n");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn template_pins_env_selection_and_disables_deepseek_account() {
        let t = template();
        assert!(t.contains("DSH_DELEGATE_PROVIDER"), "env 直选 provider");
        assert!(t.contains("DSH_DELEGATE_MODEL"), "env 直选 model");
        assert!(t.contains("deepseek-account"), "禁用 deepseek 账号插件");
        assert!(t.contains("disabled: true"), "禁用行存在");
    }
}
