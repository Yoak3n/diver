# 修改自身提示词（revise-prompt）

你可以修改自己的系统提示词槽位。不需要专用编辑工具——用现有 `read` / `edit` / `write` 即可。

**改完不必重启**：prompts 每次组装时热读，下一拍即生效。

## 提示词文件在哪

1. **默认槽位（随包）**：`{{bundled_prompt_dir}}`
   - 每个 `*.md` = 一个 systemPrompt section
   - 升级安装包可能覆盖此目录，**长期自改请写到覆盖层**
2. **覆盖层（推荐写入）**：`{{override_prompt_dir}}`
   - 同名文件覆盖默认槽位
   - 在 COS_HOME 下，永远可写、升级不丢

两个目录都是绝对路径，直接作为 `file_path` 传给 read/edit/write。

## 文件格式

```markdown
---
order: 110
name: style
---
（提示词正文，Markdown）
```

| 字段 | 含义 | 约束 |
|---|---|---|
| `order` | systemPrompt 排序 | **必填整数**。现有：memory 关系卡 15、persona 90、skill 目录 95、工具引导 100、表达层 110 |
| `name` | 槽位名 | 可选，缺省用文件名（不含 `.md`）。section 名为 `diver:self-prompt:<name>` |
| 正文 | 注入的提示词 | 非空；单文件 ≤ 32KB |

新增文件 = 新增槽位；改已有文件 = 改对应提示词。**不要改 `.ts` 源码**——只动 `prompts/*.md`。

## 怎么改

1. `read` 目标文件（write/edit 有 read-first 守卫）
2. `edit` 做局部修改，或 `write` 整文件覆写（先读再写）
3. 保持 frontmatter 完整：`order` 整数、`---` 闭合、正文非空
4. 需要新槽位时：在覆盖层新建 `xxx.md`，写好 frontmatter + 正文
5. **完成**——下一拍组装时自动加载，无需 `restart_agent`

坏文件会被跳过并打日志，不会拖垮整个插件；改了却没生效时先检查 frontmatter。

## restart_agent 何时用

- **不必用**：改 `prompts/*.md` / 本 skill 正文（都是热加载）
- **可以用**：需要重载插件代码、核心服务，或运行时状态异常想干净重来
- 调用后写 `$COS_HOME/restart.requested` 并优雅退出，壳会自动再拉起
- 重启完成会注入 `[system] 重启完成…` 系统事件

## 边界（不要越界）

- **不改身份**：「我是谁 / 和用户的关系」在 memory 的 identity 工具，不在这里
- **不改 harness 核心**：`@cos/*`、工具实现、插件 `.ts` 源码都不归本 skill 管
- **order 想清楚再动**：表达层通常放 110（工具引导之后压轴）；放太前会盖过身份/工具说明
- 用户明确要求改风格时再改；闲聊中不要擅自重写提示词

## 改完如何自检

- frontmatter 能解析（`order` 是整数、`---` 成对）
- 正文是你想要的完整文本，不是半截
- 不需要重启；若怀疑没生效，先 `read` 回文件核对内容
