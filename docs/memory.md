# 关系层记忆

陪伴 agent 的长期记忆系统，双端架构：

- **Node 插件**（`harness/companion/lib/memory/`）— agent 侧的智能层：
  agent 主动 remember 工具、会话末 digest 归纳、压缩摘要内化、常驻注入、agent 工具面
- **Rust 后端**（`crates/diver-memory` + `src-tauri/src/services/`）— 确定性层：
  SQLite 存储、衰减/激活/遗忘、阻塞候选、统计快照，经本地 HTTP JSON-RPC 暴露

> 早期版本记忆落在 `$DSH_HOME/memory/` 的 JSON 文件；现迁移为 Rust SQLite 后端，
> JSON 文件布局已废弃（数据文件 `diver-memory.sqlite3` 位于 app data 目录）。

## 架构与数据流

```
agent（Node）
  ├─ 主动 remember 工具：对话中自觉沉淀（无逐轮 LLM 提取）
  ├─ 会话末 digest（节流）：transcript → LLM → 关系卡增量
  ├─ compaction/summary：把压缩摘要内化为长期记忆
  ├─ 写入：remember / append_event / upsert_promise / update_card（经 RPC）
  └─ 常驻注入：systemPrompt.section(order 15) ← 同步视图缓存（快照）
          │
          ▼ HTTP JSON-RPC（127.0.0.1:<DIVER_MEMORY_PORT>/rpc）
Rust（axum + rusqlite，单文件 SQLite）
  ├─ topics / events / relation_card / promises / self_history 五张表
  ├─ 衰减/激活/遗忘（读取相关数据时懒执行）
  ├─ blocking_candidates / stats / snapshot
  └─ 数据文件：app_data_dir()/diver-memory.sqlite3
```

Node 侧 `store-rpc.ts` 是 Rust 后端的客户端：RPC 读写 + 维护一份 `snapshot` 视图缓存
（system prompt 的 section provider 只允许同步返回字符串，用缓存避免异步）。

## SQLite Schema（crates/diver-memory/src/db.rs）

```sql
topics          -- 主题层：id(不透明稳定)/canonical_name/aliases/state_summary/
                --   weight/tier(episodic|trivia)/activation_count/时间锚点/
                --   n_times/uncertain/demoted_at/demoted_reason
events          -- 事件层：append-only（seq 自增、topic_id、statement、ts、episode_id）
relation_card   -- 关系卡：profile（关于用户）/ agent_model（关于自己）/ relationship
promises        -- 承诺：content/status(open|done|expired)/due_at
self_history    -- 行为史：kind/content/topic_id/ts（如建议去重）
```

## JSON-RPC 协议

`POST http://127.0.0.1:<port>/rpc`，请求 `{ "method", "params" }`，
响应 `{ "ok": true, "data" }` / `{ "ok": false, "error" }`。

| 分组 | 方法 |
|---|---|
| topics | `list_topics` `get_topic` `create_topic` `merge_topic` `delete_topic` |
| 衰减/激活 | `decay_all` `activate` `activate_by_text` `blocking_candidates` `demote` |
| 写入 | `remember` `append_event` `update_card` `upsert_promise` `append_self_action` |
| 读取 | `today_events` `recent_episodes` `get_card` `list_promises` `recent_self_actions` |
| 诊断 | `stats` `snapshot` |

新增方法：`services/memory.rs` 的 `dispatch` 加一行即可；新增服务则按 method 前缀在
`rpc.rs` 分流，并在 `ServiceState` 挂共享状态。

## 记忆机制

| 机制 | 实现 |
|---|---|
| Agent 主动 remember（工具） | 对话中由 agent 自觉调用 `remember` 写 topics；**不做逐轮 LLM 提取** |
| 会话末 digest（节流） | 积累 ≥3 对 turn pair 且距上次 digest ≥10 分钟 → LLM 归纳关系卡增量 |
| 压缩内化 | 监听 `compaction/summary` 事件，把早期对话摘要写入「会话历史回顾」话题 |
| 常驻注入 | `systemPrompt.section`（order 15）：关系卡 + Mode B（近期经历/未完成承诺/今天事件），永不检索 |
| 衰减/激活/遗忘 | episodic 0.05/天、trivia 0.15/天线性衰减（Rust 侧懒执行）；用户提起 → activation+1 权重恢复 ≥0.6；低于阈值系统遗忘 |
| Agent 工具面 | `remember` / `recall` / `inventory` / `demote`（只加强/减弱，不亲手删，可逆） |
| 快照视图 | store-rpc 维护 `snapshot` 缓存：card/promises 全量，topics/events 只取最近 200 条；`events` 超出 2000 条自动裁剪 |
| 读取 | `recall` 走 `blocking_candidates`（词法 contains，≥2 字符文本命中）；无命中时 Mode B 近期经历兜底 |

## 验证

`node scripts/memory-test.mjs` 覆盖：引导 agent 通过 `remember` 工具写入事实 → recall 型问题
（名字/忌口/爱好）回答正确 → 调 `/rpc` 做 create/snapshot/delete 的 SQLite 落库验证。
注意：**不再断言“每轮自动 remember”**；记忆来源为 ① agent 主动 `remember` 工具 ② 会话末 digest ③ 压缩摘要内化。
