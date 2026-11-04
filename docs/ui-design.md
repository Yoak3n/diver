# UI 设计系统（基础组件）

> 状态：**已落地（2026-10-28）**。
> 视觉基线：极简纸感（Notion / 纸面阅读工具），暖纸白 + 近黑墨色，靠字重、留白与
> 1px 描边分层，几乎不用阴影。
>
> 相关：[插件 UI 运行时](plugin-ui-runtime.md) · [架构](architecture.md)

---

## 1. 原则

1. **纸面优先**：背景用 `--paper` / `--paper-raised` / `--paper-sunken` 三层，
   浮层才用 `--shadow-sm` 以上的投影。
2. **克制几何**：圆角 6 / 8 / 10 / pill 四档；不出现大圆角卡片。
3. **状态色只做语义**：`--ok` / `--warn` / `--err` / `--accent`，不用于装饰。
4. **动效只动 transform / opacity**：`--dur-press` 120ms、`--dur-hover` 150ms、
   `--dur-ui` 200ms，统一 `--ease-out`。
5. **焦点可见**：所有可交互元素必须有 `:focus-visible` 描边或焦点环。
6. **暗色跟随系统**：`prefers-color-scheme: dark` 只换 token，不写第二套组件样式。

---

## 2. Token

定义在 [`src/style.css`](../src/style.css) 的 `:root`。

| 类别 | Token | 用途 |
|---|---|---|
| 纸面 | `--paper` `--paper-raised` `--paper-sunken` | 页面 / 卡片 / 下沉区 |
| 墨色 | `--ink` `--ink-soft` `--ink-muted` `--ink-dim` `--ink-faint` | 正文 / 次级 / 说明 / 占位 |
| 描边 | `--rule` `--rule-strong` | 分割线 / 控件边框 |
| 强调 | `--accent` `--accent-soft` `--accent-border` | 链接 / 焦点 / 选中 |
| 状态 | `--ok` `--warn` `--err` `--err-soft` `--err-border` | 成功 / 警告 / 失败 |
| 间距 | `--space-1` … `--space-6`（4/8/12/16/24/32） | 新组件统一使用 |
| 字号 | `--text-xs` `--text-sm` `--text-base` `--text-md`（11/12/13/14） | 说明 / 控件 / 正文 |
| 控件 | `--control-h` 34px、`--control-h-sm` 28px、`--control-px` 11px | 按钮 / 输入框同高 |
| 焦点 | `--focus-ring` | 输入框焦点环 |
| 圆角 | `--radius-sm` `--radius` `--radius-lg` `--radius-pill` | 6 / 8 / 10 / pill |

---

## 3. 基础组件（`src/ui/`）

插件与产品共用；`@diver/plugin-ui` 已 re-export 全部组件。

| 组件 | Props | 用途 |
|---|---|---|
| `Button` | `variant: default/primary/ghost/danger`、`size: sm/md`、`disabled` | 所有按钮 |
| `IconButton` | `label`（必填，作 aria-label）、`size` | 纯图标操作 |
| `Input` | `v-model`、`type`、`placeholder`、`disabled`、`size: sm/md` | 文本 / 密码 / 数字 |
| `Select` | `v-model`、`options: {value,label}[]`、`size: sm/md` | 下拉选择 |
| `Checkbox` | `v-model: boolean`、`label` | 复选 |
| `Switch` | `v-model: boolean`、`label` | 开关 |
| `Field` | `label`、`description`、`error`、`layout: vertical/horizontal` | 表单字段四段式 |
| `Card` | `title`、`description`、`padded` | 纸面卡片 |
| `Badge` | `tone: neutral/ok/warn/err/accent` | 状态标签 |
| `StatusDot` | `tone: idle/ok/warn/err`、`pulse` | 状态点 |
| `InlineNotice` | `tone: ok/err/hint` | 行内提示 |
| `EmptyState` | `title`、`description` | 空状态 |
| `PageHeader` | `title`、`description` | 页面标题区 |
| `SectionTitle` | `title`、`description` | 设置页内区块标题 |

使用规则：

- 新界面一律用基础组件，不再复制 `.btn` / `.card` / `.badge` 的 scoped 样式。
- 插件 UI 只从 `@diver/plugin-ui` 取组件，不 import `src/components/**`。
- 表单统一用 `Field` + `Input`/`Select`/`Checkbox`；`Field` 的 `horizontal` 用于
  设置页「10rem 标签列 + 控件列」。
- 状态文案与颜色分离：颜色由 `tone` 决定，文案留在业务组件。

---

## 4. 已迁移界面

| 界面 | 组件 |
|---|---|
| 插件配置表单 | `ConfigForm` → `Card` + `Field` + `Input`/`Select`/`Checkbox` + `Button` |
| QQ 接入页 | `OnebotPanel` → `PageHeader` + `Card` + `Field` + `InlineNotice` + `StatusDot` + `Button` |
| 插件详情 | `PluginDetail` → `Badge` + `Button` + `Switch` + `ConfigForm` |
| 插件二级菜单 | `PluginNav` → `StatusDot` |
| 实例页 | `InstancesTab` → `PageHeader` + `Input` + `Button` + `InlineNotice` |
| 实例行 | `InstanceRow` → `Badge` + `Button` + `Input` + `Select` |
| 插件页 | `PluginsTab` → `SectionTitle` + `Button` + `InlineNotice` |
| 运行档案 / 安装区 | `SectionTitle` + `Badge` + `Button` + `Input` |
| 模型页 | `SectionTitle` + `Card` + `Field` + `Input`/`Select` + `Badge`/`StatusDot` |
| 自定义提供商表单 | `Card` + `Field` + `Input` + `Button` + `InlineNotice` |
| 语音页 | `PageHeader` + `Field` + `Input`/`Select` + `Switch` + `Button` + `InlineNotice` |
| 设置页导航 | 选中态加 `inset 2px` 墨色指示条；内容栏 `max-width: 1040px` 居中 |

全局 `.hint` 统一为 12px / 1.6 行高，取代各页 11px 的 scoped 覆盖。

---

## 5. 无障碍

- 按钮 / 导航 / 链接：`:focus-visible` 2px `--accent-border` 描边，`outline-offset: 2px`。
- 输入框 / 下拉：`:focus` 时 `--accent-border` + `--focus-ring`。
- 复选框 / 开关：焦点环落在自绘控件上，原生 input 保留键盘语义。
- `prefers-reduced-motion: reduce` 已在 `style-extra.css` 全局降级。
- `InlineNotice` 的 `err` 语气带 `role="alert"`，其余为 `role="status"`。

---

## 6. 后续

- 逐步把聊天区（输入栏 / 消息卡 / 活动摘要）的 scoped `.btn` / `.card` 迁到基础组件。
- 暗色主题逐页截图验收（当前只保证 token 覆盖）。
- 若引入图标库，统一经 `IconButton` / `Button` 的 slot，不直接散落 SVG。
