# cos

A plugin-based agent harness built on [Cordis](https://github.com/cordiverse/cordis). Every capability is a Cordis plugin living in its own workspace package under `packages/`, composed together by `cordis.yml` at boot time.

## 项目结构

```
cordis.yml             # 基础组装文件：每行一个插件（Loader 解析 @cos/* 包名）
cordis.patch.yml       # 用户补丁层，boot 时自动加载（最后应用）
overlays/              # 覆盖层：在基础 cordis.yml 之上做增删改
bundles/               # 组合层目录（非工作区包，用 --bundles 显式启用）
packages/              # 所有 @cos/* 工作区插件包
  boot/                #   启动逻辑：装配树、加载补丁/覆盖层、fail-loud
  llm/                 #   适配器注册表 + 流式组装
  llm-deepseek/        #   DeepSeek 真实适配器（默认）
  mock-llm/            #   本地 mock 模型（可选，测试用）
  credentials/         #   凭据无缝（读取 secrets.yml）
  session/ persistence/ agent-loop/ tools/ ...
  sidecar/             #   companion HTTP/SSE 入口（桌面集成）
main.ts                # 一次性 CLI（--prompt）
secrets.example.yml    # 密钥文件模板（gitignored）
```

## 环境要求

- Node.js `^22`
- [pnpm](https://pnpm.io/)

首次运行先安装依赖：

```sh
pnpm install
```

## 快速开始

### 1. 配置密钥文件（默认真实模型需要密钥）

```sh
cp secrets.example.yml secrets.yml
# 编辑 secrets.yml，填入真实 DeepSeek API key：
#   deepseek:
#     apiKey: sk-...
```

`secrets.yml` 已被 gitignore，不会提交。

### 2. 一次性对话（CLI）

```sh
pnpm start --prompt "你好"
# 等价：pnpm dev -- --prompt "你好"
```

不带 `--prompt` 会打印用法并退出。  
**stdin/stdout JSON-RPC 已移除**；桌面/上层 UI 请用下面的 companion HTTP/SSE。

### 3. 模型选择：真实 DeepSeek（默认）vs mock

默认 `cordis.yml` 挂载的是 **真实 DeepSeek 适配器**（provider `deepseek-official`，模型 `deepseek-v4-flash`）。只要配置好 `secrets.yml` 里的 API key 即可直接用——默认就是真实模型，无需任何额外参数。

想用本地 **mock 模型**（本地回显、无需密钥、可离线调试）来测试，用 `overlays/mock.yml` 覆盖层切换即可：

```sh
# PowerShell
$env:COS_OVERLAYS = "overlays/mock.yml"

# cmd / bash
set COS_OVERLAYS=overlays/mock.yml
export COS_OVERLAYS=overlays/mock.yml
```

或通过命令行参数（优先级更高，覆盖环境变量）：

```sh
pnpm start --overlays overlays/mock.yml --prompt "你好"
```

覆盖层是可叠加的：`COS_OVERLAYS` 环境变量先应用，随后是 `--overlays` 显式参数。真实模式下 DeepSeek 的 API key 通过 `@cos/credentials` 从 `secrets.yml` 读取（key `deepseek.apiKey`）；密钥缺失时启动会 fail-loud 并给出诊断。

## 其它启动选项

```sh
pnpm start --prompt "…" --provider <provider> --model <model>   # 显式指定路由
pnpm start --config path/to/cordis.yml                          # 指定基础组装文件
pnpm start --bundles <bundle>...                                # 命名 bundle 层（flat 模式）
pnpm start --patch path/to/cordis.patch.yml                     # 指定用户补丁层
pnpm start --profile <name> --cos-home <home>                   # DSH 对齐的 profile 模式（通用）
pnpm start:companion                                            # companion HTTP/SSE（cos-plugins 路径）
pnpm plugin --profile <name> -- add <package>                   # pnpm 转发：通用 profile 插件管理
```

**companion / diver 模式**：`start:companion` 把 bundle 指向
`../cos-plugins/bundle-companion`，`@diver/*` 经 `--plugin-root ../cos-plugins`
从源码加载——零安装、改 `cos-plugins/` 重启即生效。**profile 模式（通用 DSH 形态）**：
第三方插件装在 `<home>/profiles/<name>/`，层级顺序为
`cordis.yml → overlays → profile bundles → --bundles → profile patch → home/--patch`。
详见 `docs/plugins.md` 与仓库根 `docs/channels.md`。

## companion（HTTP/SSE）— 唯一常驻集成面

Diver 桌面端与上层 UI 使用常驻 HTTP/SSE 入口
`cos-plugins/companion/src/companion.ts`（dev）或 `companion-bundle.ts`（随包 Node）。
**不使用** stdin/stdout JSON-RPC（已移除）。

```sh
node --import tsx --expose-internals ../cos-plugins/companion/src/companion.ts \
     --profile companion \
     --plugin-root ../cos-plugins \
     --bundles ../cos-plugins/bundle-companion \
     --harness .
# 启动 HTTP/SSE，打印 DIVER_READY
```

- **为什么用 tsx**：Node 22 原生 type-strip 不支持 TS 参数属性
  （`constructor(private x: string)`），`@cos/*` 引擎大量使用；tsx 完整编译。
- **为什么核心包用 pluginPaths 映射**：随包布局下 pnpm 的 node_modules 链接链
  会断裂，显式映射到 `harness/packages/<pkg>/src/index.ts` 最稳。
- 运行时由外层程序（Tauri 壳）注入 `COS_HOME` 与 `DIVER_PORT`。
- Diver 的打包编排见仓库根 `scripts/bundle-release.mjs` 与 `docs/distribution.md`。

## 常用命令

```sh
pnpm run typecheck   # 类型检查
pnpm start:companion # companion HTTP/SSE
pnpm run scaffold    # 生成新插件骨架
```

## 故障排查

- **`deepseek.apiKey is required and unresolved`**：`secrets.yml` 缺失或未配置 `deepseek.apiKey`（或 `credentials.config.file` 指向的文件里没有该 key）。
- **想关掉 system-prompt 调试打印**：应用 `overlays/quiet.yml`，或把 `cordis.yml` 中 agent-loop 行的 `debugSystemPrompt` 设为 `false`。

## 说明

- 这是独立于 DeepSeek Harness 的再造/教学实现，代码与文档约定遵循仓库根目录的 `AGENTS.md`。
- 仓库已 `git init` 并有首次提交；`.gitignore` 已忽略 `secrets.yml`、`.sessions/`、`node_modules/` 等，请不要把真实密钥提交进仓库。
