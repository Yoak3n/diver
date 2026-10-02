# 委派 dsh：模型渠道（provider）指定规矩

派单给 dsh（`delegate_task`）前先读这份规矩。

## 硬规矩

1. **不要走 DeepSeek 官方 API。** 派单 overlay 已禁用 `deepseek-account`，
   缺省渠道是用户自己的 `ark-agent-plan-cn`。除非用户**明确要求**，任何
   任务都不要改回官方渠道。
2. **用户指定模型/渠道时，派单参数里带上它。** `delegate_task` 的
   `provider` / `model` 参数会以环境变量（`DSH_DELEGATE_PROVIDER` /
   `DSH_DELEGATE_MODEL`）进派单进程，overlay 按它路由——这是唯一正确
   的逐单指定通道，不要去改全局配置。

## 机制一图（为什么是 env 而不是旗标）

`dsh --profile headless` **没有 `--provider` 旗标**，provider 走配置面的
`agent-default-model`。派单链路：

```
delegate_task(provider, model)
  → 环境变量 DSH_DELEGATE_PROVIDER / DSH_DELEGATE_MODEL
  → $COS_HOME/dsh-delegate-overlay.yml 里 `!!js` 直选
  → dsh headless 按该渠道起 agent
```

- 不传 `provider`/`model` = 用 overlay 的缺省（`ark-agent-plan-cn` /
  `doubao-seed-2.1-pro`）。
- 想换缺省：编辑 `{{cos_home}}/dsh-delegate-overlay.yml`（播种后归用户；
  删掉文件会按出厂模板重新生成）。
- overlay 里没有的 provider：先把条目加进该文件的 `llm-pi-ai.providers`
  （含 `apiKeyEnv` 指向 credentials 的 ref），再派单。

## 取消息不止被动等回报

进度/终态会自动回报；需要中途看细节或事后回看时用 `get_task_events`：
`source: 'stream'`（`--json` 事件流摘要+尾部原文）/ `'session'`（会话日志，
含完整 assistant 文本与工具轨迹）/ `'checkpoint'`（title/统计摘要）/
`'all'`（三通道组合）。
