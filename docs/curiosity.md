# 好奇心驱动（curiosity）

探索驱动不再只在 topics 表里找词。候选来自「生活里反复出现的东西」，先攒成一张
持久的好奇心清单，空闲时由壳端 ExplorePolicy 按条消费，结果再写回 topics。

## 为什么改

旧实现（`pickTerms`）只读 topics 且要求 `nTimes >= 2`；`uncertain` 实际永远为
false，候选池极窄。没有候选时壳端每 45 秒白轮询一次，日志反复出现
`[explore] 无候选词，本次跳过`。探索结果又用覆盖式 `remember` 写回，查一次反而
把原 topic 的 `state_summary` 冲掉。

现在：

```
群聊滚动缓冲 ─┐
owner 笔记   ─┼→ curiosity_items (SQLite) ─→ pick-terms ─→ 壳 ExplorePolicy ─→ explore job
实体表       ─┤         ↑                                              │
订阅源       ─┘         └──────────── claim / complete / release ──────┘
                                                                       ↓
                                        LLM 提炼 → topics（append）→ recall / 关系卡
                                                                       ↓
                                        每 2 天、≥2 条、09–23 点 → presence 注入
```

## 队列

Rust `diver-memory` 新表 `curiosity_items`（`crates/diver-memory/src/db/curiosity.rs`）：

| 字段 | 说明 |
|---|---|
| `term` | 展示词（2–40 字符） |
| `dedupe_key` | 唯一：普通词=归一化词面；release=`release:<repo>:<id>`；页面=`watch:<source>:<hash>`；平台=`platform:bilibili:<bvid>` |
| `source` | `chat:group:<id>` / `note:<scope>` / `entity` / `subscription:<id>` / `platform:bilibili` / `topic` / `manual` |
| `reason` | `chat_mention` / `note_pending` / `entity` / `release` / `watch` / `platform_trend` / … |
| `priority` | 来源基础权重（引号 2.2、笔记待查 2.6、实体 1.5、订阅 2.0、平台 1.6–1.8、中文重复 1.2） |
| `status` | `open → claimed → done / open`（失败重试 3 次后 `skipped`） |
| `occurrences` | 去重合并次数 |
| `payload` | 订阅/平台已抓到的正文；job 见到它就不再做联网搜索，完成后清空 |
| `note` | 完成时写入的一句话结论，供汇报 |

评分（Rust 纯函数）：`priority × (1 + min(ln(occurrences), 3)) × 7 天半衰期 × 尝试惩罚`。
open 超 30 天 `expired`；done/skipped/expired 超 90 天清理；open + claimed 上限 300。

RPC：`curiosity_upsert / curiosity_get / curiosity_pick / curiosity_list /
curiosity_claim / curiosity_release / curiosity_complete / curiosity_done_since /
curiosity_counts`。`curiosity_release(resetAttempts=true)` 用于用户聊天打断——不消耗重试次数。

## 取词（sidecar `@diver/memory`）

纯函数 `curiosity-extract.ts`，不做通用分词：

- 引号/书名号/反引号内容：最高优先级；
- Latin 专名（含大写/数字/`.-_`）：`DeepSeek`、`MXene`、`v0.2.13`；全小写要求出现 ≥2 次；
- 中文 2–6 字 n-gram：在扫描窗口内重复 ≥2 次，且不能以虚词/语气词起止；
- 笔记：标题、列表项、含「待查 / 想查 / 查一下 / TODO / ?」的行直接取，不要求重复。

IO 在 `curiosity-sources.ts`：

| 来源 | 位置 | 游标 |
|---|---|---|
| 群聊 | `$COS_HOME/onebot/groups/*.jsonl` | 每文件最后消息时间；首次回填 24h |
| 笔记 | `$COS_HOME/notes/owner/**`（`.md/.txt`） | 每文件 mtime+size |
| 实体 | 记忆 RPC `list_entities` | 每次全量，`mention_count >= 2` |

每轮每源最多 20 条；扫描单飞 + 30 分钟节流；队列为空时 `pickTerms` 会 force 一次
（2 分钟地板）。运行态在 `$COS_HOME/curiosity/state.json`（原子写）。

**隐私边界**：只扫白名单群 + owner 笔记；不扫 `private-*` / `group-*` 笔记，也不扫
陌生人私聊；只存词与群号，不存原句；探索结果落 `owner` 作用域。

## 订阅

默认**不轮询任何官网/新闻页**，只跟 GitHub release。需要盯某个 changelog 时，自己在
`$COS_HOME/curiosity/sources.json` 加页面源：

```json
[
  { "id": "my-changelog", "kind": "page", "title": "某项目更新",
    "url": "https://example.com/changelog", "intervalMs": 21600000 }
]
```

- GitHub 源（默认）：`GET api.github.com/repos/<owner>/<repo>/releases?per_page=1`，
  带 ETag；新 release 的 body 作为 `payload`。默认 3 小时一次、最多 8 个仓库，
  远低于未认证限流；403 退避 1 小时。
- 页面源（可选）：抓正文 → FNV 指纹 → 行级多重集 diff → 新增行作为 `payload`；
  首次只记基线。正文 <200 字符会告警（可能是 SPA，建议换 URL）。
- 仓库识别：从 owner/global topics、实体、owner 笔记、群聊缓冲里认
  `github.com/owner/repo` 与重复出现的 `owner/repo`，最多 8 个；设置页「额外仓库」可手填。
- 订阅只负责发现变化入队；真正的「消化」仍由壳端在空闲时逐条触发。

## 平台见闻（B站，只读）

闲置时看 B 站热榜/搜索、视频详情、弹幕和评论区；默认匿名，也可在好奇心清单里
扫码登录一个只读小号（cookie 含自动续期凭据）换取更完整的评论/字幕。仍然不评论、不点赞、
不私信。结果按视频主题落 topic，摘要以 `【平台见闻·B站】` 开头，完成后清空原始
评论/弹幕 payload。完整设计、接口与边界见 [platform-observer.md](platform-observer.md)。

## 落地 topics

`explore-summarizer.ts` / `explore-distill.ts` / `explore-land.ts`：

1. 用当前模型提炼 1 句结论 + ≤3 条要点（`ctx.llm.stream`，20s 超时）；平台条目走
   专用提示词（主题/结论/要点/人群视角）；失败/关闭时退回页面/搜索首句摘录。
2. `fromMemoryId` 优先；否则精确匹配词面（含旧的 `探索:<term>`），最后做包含匹配。
3. 命中：RPC `append_topic_summary`（保留旧摘要、追加 `【查到】…`、`weight ≥ 0.6`、
   `n_times+1`、`uncertain=false`）；未命中：新建 `episodic` topic（scope=owner）。
4. 追加一条 ≤140 字 event，供关系卡【今天】使用。
5. `curiosity_complete` 记下 topic_id 与一句话结论。

## 主动小结

`curiosity-report.ts` + 壳端 RPC `presence::inject`：

- 每 30 分钟检查一次；只在本地时间 09:00–23:00；
- 距上次成功 ≥ `reportEveryDays`（默认 2 天）；`done_at` 之后至少有 `reportMinItems`
  （默认 2）条带结论的条目；最多挑 3 条；
- 文案是给 agent 的由头（「挑一件自然地说，别逐条复述，也别提系统/报告」）；
- 投递先走 presence L1（仅 `receptive`）+ L2（ProactiveSpeak）；被拒/失败 2 小时后再试，
  24 小时内最多 3 次；成功后推进 `lastReportAt`。

## 配置

「设置 → 插件 → 记忆」的通用配置表单（持久化在 profile `cordis.patch.yml`）：

| key | 默认 | 说明 |
|---|---|---|
| `curiosityEnabled` | true | 总开关 |
| `chatScan` / `notesScan` | true | 群聊 / 笔记取词 |
| `subscriptions` | true | GitHub release 订阅（页面源需自配） |
| `extraRepos` | "" | 额外 `owner/repo`，逗号/换行 |
| `scanLimit` | 20 | 每轮每源新增上限 |
| `llmSummary` | true | LLM 提炼；关掉用摘录 |
| `reportEnabled` | true | 主动小结 |
| `reportEveryDays` | 2 | 最小间隔 |
| `reportMinItems` | 2 | 最少条数 |

设置页「状态机」底部有只读清单：待探索/已完成数量、前 8 条、上次取词/小结时间。

## 调试

```bash
node scripts/curiosity.mjs          # 打队列计数 + 明细 + state.json 里的位点
node scripts/curiosity.mjs --open   # 只看待探索
```

## 已知边界

- 中文取词是启发式，仍可能进噪声；靠重复阈值、停用词、每轮上限、30 天过期、UI 可见
  和总开关控制。发现坏词可直接在设置页看到（当前只读，删除入口后续再加）。
- 自配的页面源若是 SPA，正文可能抓不到；换 `sources.json` 里的 URL 即可。
- GitHub 未认证限流 60 次/小时；默认 3 小时一次、最多 8 个仓库，远低于上限；也支持
  `GITHUB_TOKEN`。
- LLM 提炼失败会静默退回摘录，不阻塞落地。
