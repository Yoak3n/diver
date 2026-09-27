# TTS：流式合成与双窗播报

> 配置真源是壳层 `src-tauri/src/config/tts.rs`（文件 `tts.json`，写在
> **app_config_dir**，Windows 即 `%APPDATA%\com.diver.companion\tts.json`）——
> 旧文档写 `config/tts.json` / resources/ 下均过时。合成与播放由壳层 Rust 直连
> 在线 API（无本地 SAPI）；前端只挂播放器与发起请求。

## 配置（`config/tts.rs`）

`TtsConfig`（serde camelCase，坏文件/缺文件回默认）：`enabled`（缺省 false）、
`provider`（`mimo`｜`minimax`｜`volcengine`）、`voice`（缺省「冰糖」）、`model`
（缺省 `mimo-v2.5-tts`）、`speed`（0.25–4.0）、`api_host`、`api_key`（secret，
视图只回 `has_api_key` 布尔）、`resource_id`（火山 Agent）、`style_instruction`
（MiMo 风格指令）、`format`（mp3/wav）、`custom_voices`。

切换 provider 时自动纠正缺省 model/api_host（`normalize_provider_defaults`）；
设置页「语音」Tab（`VoiceTab.vue` + `useTtsSettings.ts`）编辑，watch 自动持久化。

## 服务商与协议（`core/tts/synth/`）

| 服务商 | 端点/协议 | 整段 | 流式 |
|---|---|---|---|
| MiMo | OpenAI 兼容 `chat/completions` | `choices[0].message.audio.data` base64 | **SSE** + `audio.format:"pcm16"`（24kHz PCM16LE mono），逐 `data:` 行分片 |
| MiniMax | `/v1/t2a_v2`（默认 `speech-02-hd`，32kHz） | `data.audio` **hex** 解码或 `data.url` 下载 | 不支持（回退整段） |
| Volcengine | `openspeech.bytedance.com/api/v3/tts/unidirectional`（Agent 版，`X-Api-Key`） | NDJSON 逐行 base64 拼接 | 不支持 |

仅 MiMo 支持流式（`resolve_stream_voice` 对非 MiMo 返回 `STREAM_UNSUPPORTED`，
调用方自动回退整段合成）。

## 双窗播报（`core/tts/player.rs`）

进程级 `TtsPlayer` 单例，两个**播放窗槽位**：

- **pet 优先、main 兜底**：`send()` 取 `pet.or(main)`——桌宠窗开着时音频从桌宠窗
  播（并驱动 Live2D 口型），关了从主窗播；
- **谁挂播放器**：`PetApp` → `useLipSync` 挂 `pet` 槽；`App.vue` 非 pet 路由挂
  `main` 槽（`tts_attach_player(kind, on_event)`）；
- **队列语义**：latest-wins + `force` 打断（generation 计数）；空文本/无播放窗报错；
- **事件流**（`TtsPlayerEvent`，camelCase 对齐前端）：`start / pcm / audio /
  synthDone / stopped / speaking`。

## 命令面（`commands/tts.rs` + `commands/tts_player.rs`）

| 命令 | 作用 |
|---|---|
| `get/set_tts_config` | 配置读写（secret 不回传） |
| `tts_list_voices` / `tts_list_models` | 声线表（三家 + custom_voices） |
| `tts_synthesize` | 整段合成 → `TtsAudio{base64,mime}` |
| `tts_synthesize_stream` | 流式合成 → `Channel<TtsPcmChunk>` 推 PCM 分片 |
| `tts_attach_player` / `tts_detach_player` | 挂/摘播放窗槽位（事件回传 Channel） |
| `tts_speak(text, voice, force)` | 入队播报（合成+推送全在后端） |
| `tts_stop` | 停止 |
| `tts_report_end(requestId)` | 前端播完回报，推进队列（等待超时 90s） |

## 前端播放（`src/tts/`）

- 流式：WebAudio AudioContext 24kHz 调度排程（`pcm.ts`）；整段：Blob +
  `HTMLAudioElement`（`player.ts`）；
- 响度/口型电平：流式 PCM 共享 AnalyserNode（`level.ts`）；整段 audio 不再接
  analyser（无电平，口型回退正弦）；
- 发起方：聊天自动朗读（`chat/ttsBridge.ts`，assistant 完成且 enabled）、消息
  手动点读（force）、设置试听；**去重**按文本前 300 字符 60s TTL（`tts/queue.ts`
  + `spoken.ts`），force/userGesture 绕过；桌宠窗只挂播放器不发起 speak。

## 已知遗留

- `src/tts/types.ts` 的 `tts://*` 事件常量、`src/ipc/tts.ts` 的
  `synthesizeTts/synthesizeTtsStream` 封装无调用方（后端命令仍注册）；
- 桌宠侧 `usePetChat` 的 `ttsEnabled/ttsVoice` refs 无消费方（挂播放器 + 读配置
  就够了）；
- 无音频输出设备选择——「双窗」指输出窗口切换。
