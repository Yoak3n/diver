# 平台观察者（B 站，只读）

> 让 Diver 在闲置时看看 B 站热榜/搜索、视频、弹幕和评论区，
> 默默理解“世界上正在发生什么、不同的人怎么想”，再沉淀成自己的记忆。
> **默认匿名、只读、不互动**；可选扫码登录只换取更完整的评论/字幕，仍然不写。

参考了 [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) 的
节奏与抓取思路，以及 [pskdje/bilibili-API-collect](https://github.com/pskdje/bilibili-API-collect)
的接口文档；但**没有**采用它的登录、评论、私信、点赞、动态、直播弹幕等写操作。

---

## 1. 硬约束

- 所有请求都是 **GET**；代码层不提供 POST/PUT/PATCH/DELETE。
- 默认**不登录**；可选扫码登录保存 **SESSDATA / bili_jct / refresh_token**（0600）。
  `bili_jct` 只用于 passport cookie 自动续期，**代码层没有任何业务写接口**。
- 不评论、不私信、不点赞/投币/收藏/关注、不发动态、不发直播弹幕。
- 不绕过风控、不换 IP/UA、不解决验证码；触发 412/429 就退避/停。
- 不保留用户名、mid、头像；原始评论/弹幕只用于本次提炼，完成后清空 payload。

---

## 1.1 可选登录（只读）

「设置 → 状态机 → 好奇心清单 → B 站登录（只读）」扫码即可；也可以只用匿名模式。

- 流程：`POST /api/bilibili/login/qrcode` 拿二维码 → 前端每 2s 调
  `GET /api/bilibili/login/poll?key=…` → 手机确认后后端提取
  `SESSDATA`/`bili_jct`/`DedeUserID` 与响应里的 `refresh_token`，写入
  `$COS_HOME/curiosity/bilibili-auth.json`（0600）。
- 登录态只用于：
  - 评论区（更完整）；
  - 字幕：`/x/player/wbi/v2` → 字幕 JSON（未登录拿不到）。
- 排行榜/热门/匿名搜索**不带登录 cookie**，避免“大家在看什么”变成个人推荐流。
- 接口响应只回 `{loggedIn, name, mid}`，永远不回传 token；退出即删除凭据文件。

### 自动续期

- 每个平台会话做一次后台体检；续期检查 24h 节流，到期前 7 天提前触发。
- 链路：`GET /x/passport-login/web/cookie/info` → `CorrespondPath`（RSA-OAEP）
  → `GET /correspond/1/<path>` 取 `refresh_csrf` → `POST /cookie/refresh`
  → `POST /confirm/refresh`；成功后把新 cookie 覆盖写回 0600 文件。
- 只有 passport 的这三个刷新接口会用 POST；观察面仍然全是 GET。
- 续期失败或 `-101`：标记 `invalidAt`，白天（09–23）最多 24h 弹一次原生通知，
  平台观察自动退回匿名，不中断整次会话。
- 风险提示：`bili_jct` 是写 CSRF，`SESSDATA` 是 bearer token；文件泄露等于把
  账号的读写能力都交出去。建议用**专用小号**，不要共用主账号；本应用代码里没有
  评论/点赞/私信等写接口，但账号本身的风险仍由你承担。

---

## 2. 只读链路

| 步骤 | 接口 | 说明 |
|---|---|---|
| 发现 | `GET /x/web-interface/ranking/v2?rid=0&type=all` | 排行榜，最多 100 条；匿名 |
| 发现 | `GET /x/web-interface/popular?pn=1&ps=20` | 排行榜失败时兜底 |
| 发现 | `GET /x/web-interface/wbi/search/type?...` | 按兴趣匿名搜索；WBI + buvid3，不需要账号 |
| 深读 | `GET /x/web-interface/view?bvid=<BV>` | 标题/简介/分区/时长/播放/弹幕数/cid |
| 深读 | `GET https://comment.bilibili.com/<cid>.xml` | 弹幕 XML；匿名，采样 ≤120 条 |
| 深读 | `GET /x/v2/reply?type=1&oid=<aid>&sort=2&pn=1&ps=20` | 评论 best-effort；登录后更完整 |
| 深读（登录） | `GET /x/player/wbi/v2?bvid=<BV>&cid=<cid>` | 字幕轨列表；需要 SESSDATA + WBI |
| 深读（登录） | `GET <subtitle_url>` | 字幕 JSON；CDN 自带 auth_key，不再带 cookie |

WBI key 从 `/x/web-interface/nav` 取（未登录 `code:-101` 也有 `data.wbi_img`），
匿名 `buvid3` 从 `/x/frontend/finger/spi` 取；两者都有内存缓存。
搜索失败时回退排行榜；评论失败时只用详情 + 弹幕；字幕失败时跳过。

---

## 3. 看什么、怎么看

- **兴趣**：owner/global topics、实体、owner 笔记里的明确词、配置里的额外兴趣词。
- **打分**：`3*log10(1 + 弹幕数/max(30, 时长秒)) + 兴趣命中*4 + 少量随机`。
- **多样性**：同分区最多一条；保留 `platformSerendipity`% 名额给“零兴趣命中”的候选，
  避免只刷同温层。
- **过滤**：广告/带货/抽奖/扫码/加群/私信等屏蔽词；低播放低弹幕的垃圾条目；
  同一 `bvid` 只入队一次。
- **每次会话**：1 次排行/搜索 + 选中 1–2 条 ×（详情 + 弹幕 + 评论）≈ 5–7 个 GET。

---

## 4. 何时去

只在 presence 满足以下条件时抓取（`presence::snapshot`）：

- `enabled !== false`
- `user_input_active === false`
- `phase_name` ∈ `passive | observing | receptive`
- `regime` ∉ `dnd | quiet_hours | focus | sleep`
- 距上次对话 ≥ `platformIdleMinutes`（默认 20 分钟）

拿不到 presence 快照时 fail-closed。抓取受侧车门控；真正消费仍由壳端
`ExplorePolicy` 在空闲时裁决，形成双层克制。

---

## 5. 怎么落进记忆

1. 入队：`curiosity_items`，`source=platform:bilibili`，`reason=platform_trend`，
   `dedupeKey=platform:bilibili:<bvid>`，priority 1.6–1.8。
2. 空闲消费：job 直接使用预抓取 payload，不再联网搜索。
3. 平台专用提炼：`主题：` / `一句话结论：` / `- 要点` / `人群视角：`；
   摘要以 `【平台见闻·B站】` 开头，带来源 URL。
4. 落 topic：优先用 `主题：` 做 topic 名；命中已有主题就 `append_topic_summary`，
   否则新建 `episodic`（owner）。
5. 完成后清空原始 payload，只留摘要、一句话结论与来源链接。
6. 两天一次的小结里，平台见闻和其他探索一样参与，最多提 1 条。

---

## 6. 配置

「设置 → 插件 → 记忆 → 平台观察」：

| key | 默认 | 说明 |
|---|---|---|
| `platformFeeds` | true | 平台观察总开关 |
| `platformBilibili` | true | B 站适配器 |
| `platformSearch` | true | 匿名搜索（WBI + buvid3） |
| `platformComments` | true | 评论区（best-effort） |
| `platformDanmaku` | true | 弹幕 |
| `platformLogin` | true | 使用已保存的只读登录态（关掉=完全匿名） |
| `platformSubtitles` | true | 登录态下读取字幕（未登录自动跳过） |
| `platformPerSession` | 2 | 每次最多看几条 |
| `platformDailyCap` | 2 | 每天最多落几条 |
| `platformIntervalMin` | 240 | 两次会话最小间隔（分钟） |
| `platformIdleMinutes` | 20 | 闲置多久才去 |
| `platformSerendipity` | 30 | 非兴趣随机名额百分比 |
| `platformInterests` | "" | 额外兴趣词，逗号分隔 |
| `platformPresenceGate` | true | 只在闲置/独处时浏览 |

高级项：`$COS_HOME/curiosity/platforms.json`

```json
{
  "bilibili": {
    "rids": [0, 36, 188],
    "queries": ["AI", "量子计算"],
    "perRun": 2,
    "dailyCap": 2,
    "intervalMs": 14400000,
    "blockKeywords": ["广告", "带货", "抽奖"]
  }
}
```

分区 rid：知识 36、科技 188、生活 160、游戏 4、动画 1、音乐 3、纪录片 177…

---

## 7. 边界

- 评论匿名可用性不保证；登录后更完整，拿不到就降级，不重试。
- 搜索需要 WBI + 匿名 buvid3；`-412` 时回退排行榜并退避。
- 字幕需要 SESSDATA；匿名时跳过，登录后可选；视频画面/抽帧不做。
- 登录态过期（`-101`）自动退回匿名；不会因为过期中断整次观察。
- 公开接口不是官方承诺，字段/风控可能变化；适配器隔离，坏了只停平台源。
- 仅低频、只读；仍建议遵守 B 站服务条款，不做批量采集或再分发。

---

## 8. 调试

```bash
node scripts/bilibili-observe.mjs          # 只读跑一次发现+深读，打印候选与 payload
node scripts/curiosity.mjs --open          # 看队列里的 platform:bilibili 条目
```

代码落点：`cos-plugins/memory/src/curiosity-platform*.ts`、
`curiosity-bilibili*.ts`、`presence-gate.ts`；共享 JSON GET 在
`cos-plugins/web-tools/src/fetch-json.ts`。
