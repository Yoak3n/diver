# 模型提供商（一切皆插件）

设置面板的配置区由**适配器插件声明驱动**：每个 provider 适配器通过
`LlmAdapter.providerConfig()`（`@cos/llm`，见 `harness/packages/llm`）声明自己的
配置字段（类型/存储位置/必填/提示），经 `ctx.llm.listProviderConfigs()` /
`adapterConfig()` 汇总，`@diver/backend` 的设置接口原样透传给 UI 动态渲染，
**没有硬编码的配置输入框，也没有硬编码的 provider 名单**。

`@diver/backend` 不再持有任何 provider 知识：

| harness 注册面 | 后端使用点 |
|---|---|
| `ctx.llm.listProviders()` | provider 目录与显示名（适配器注册的路由） |
| `ctx.llm.listModels(provider)` | 模型下拉（适配器自己声明的模型，advisory） |
| `ctx.llm.listProviderConfigs()` / `adapterConfig()` | 配置 schema（字段声明） |
| `ctx.credentials.get(ref)` | “已配置”判定（适配器已 `provide`） |
| `credentials.config.file`（secrets 文件） | 凭据写入路径（框架配置的同一文件） |

因此**新增 provider 只需注册适配器并实现 `providerConfig()`，后端与设置面板零改动**。

## 字段落位

字段按 `store` 分两类（由适配器声明）：

| store | 落位 | 说明 |
|---|---|---|
| `credentials` | 框架配置的 secrets 文件（`credentials.config.file`，默认 `./secrets.yml`） | 凭据（如 API Key，password 类型） |
| `settings` | `diver-settings.json`（`<provider>.` 前缀） | 普通设置（如 baseUrl） |

`provider` / `model` 选择存于 `diver-settings.json`；切换后下次对话生效，会话记忆保留。
若持久化的 provider 已不在 harness 注册表（如改用了别的 overlay），后端自动钳制到
当前注册表的第一个适配器。

**自定义 base URL**：`store: 'settings'` 的字段（如 `baseUrl`）由设置面板写入
`diver-settings.json`（`<provider>.baseUrl`），适配器在**调用时**经
`LlmAdapter.settingsValue(provider, key)`（`@cos/llm`）动态读取——保存即生效，
无需重启 sidecar。

## 当前已注册的 provider 声明

| 提供商 | 声明来源 | 声明字段 | 说明 |
|---|---|---|---|
| `deepseek-official` | `@cos/llm-deepseek` 的 `providerConfig()` | apiKey（password/credentials，必填，env 兜底 `DEEPSEEK_API_KEY`）+ baseUrl（text/settings，可自定义端点） | 官方 API（`deepseek-v4-flash` / `deepseek-v4-pro`） |
| `mock` | `@cos/mock-llm` 的 `providerConfig()` | （无） | 本地 mock（离线 / 无 key 调试） |
| `commandcode` | `@diver/llm-commandcode` 的 `providerConfig()`（`cos-plugins/` 第三方插件，经 `@diver/bundle-companion` 挂载） | apiKey（password/credentials，必填，env 兜底 `COMMANDCODE_API_KEY`）+ baseUrl（text/settings，可自定义端点） | [Command Code Provider API](https://commandcode.ai/docs/provider)，适配 [GOAT 套餐](https://commandcode.ai/docs/plans/goat)：$10/月解锁 30+ 模型，同一把 key（Studio 创建）按套餐额度计量；模型目录经公开 `GET /provider/v1/models` 实时拉取（advisory） |

## 扩展新 provider

1. 实现 `LlmAdapter` 并 `ctx.llm.registerAdapter([provider], adapter)`（参考
   `@cos/llm-deepseek` / `@cos/mock-llm`，模型目录经 `listModels()` 声明）。
2. 在适配器里实现 `providerConfig(provider)` 声明配置字段；凭据字段同时
   `ctx.credentials.provide(ref, {...})` 注册来源。
3. 注册为 companion 服务行（`cordis.patch.yml` insert）。
4. 设置面板自动渲染配置区，无需改 UI。