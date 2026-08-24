# 模型提供商（一切皆插件）

设置面板的配置区由**插件声明驱动**：每个 provider 插件通过
`registerProviderConfig({provider, name, fields: [...]})`
（`harness/companion/lib/settings-registry.ts`）声明自己的配置字段
（类型/存储位置/必填/提示），UI 动态渲染，**没有硬编码的配置输入框**。

## 字段落位

字段按 `store` 分两类：

| store | 落位 | 说明 |
|---|---|---|
| `credentials` | `$DSH_HOME/.credentials.yaml` | dsh 凭据库（如 API Key，password 类型） |
| `settings` | `diver-settings.json`（`provider.` 前缀） | 普通设置（如 baseUrl） |

`provider` / `model` 选择存于 `diver-settings.json`；切换后下次对话生效，会话记忆保留。

## 当前已注册的 provider

| 提供商 | 声明字段 | 说明 |
|---|---|---|
| `deepseek-official` | apiKey（password/credentials，必填） | DeepSeek 官方 API（`deepseek-v4-flash` / `deepseek-v4-pro`，窗口 1M token） |
| `opencode-go` | apiKey（password/credentials，可选）、baseUrl（text/settings） | opencode.ai Zen Go 网关（26 个模型，无 key 也可用） |

## opencode-go 端点路由

`harness/companion/lib/llm-opencode/` 按模型表自动选择端点
（`endpointFor(model)`，OpenAI 兼容全功能优先）：

| 端点 | 能力 | 模型 |
|---|---|---|
| `/v1/chat/completions` | **全功能含工具调用** | `glm-5.3/5.2/5.1`、`kimi-k3/k2.7-code/k2.6`、`deepseek-v4-pro/flash`、`mimo-v2.5/pro`、`hy3` |
| `/v1/responses` | 第一版文本流 | `grok-4.5`、`gpt-5.6-luna` |
| `/v1/messages`（Anthropic） | 第一版文本流 | `minimax-m3/m2.7/m2.5`、`qwen3.8-max/3.7-max/3.7-plus/3.6-plus` |

> 文本流端点（responses/messages）暂不支持工具调用；选择这些模型时记忆工具自动不可用，
> 建议聊天用 chat/completions 端点模型。

可选鉴权：凭据库或环境变量 `OPENCODE_API_KEY`（无 key 时网关可裸请求）。

## 扩展新 provider

1. 实现 dsh LLM adapter（参考 `llm-opencode/` 的 `OpencodeGoAdapter`：`listModels` /
   `resolveModel` / `stream`）
2. 插件里 `registerProviderConfig` 声明配置字段
3. 注册为 companion 服务行（`cordis.patch.yml` insert）
4. 设置面板自动渲染配置区，无需改 UI
