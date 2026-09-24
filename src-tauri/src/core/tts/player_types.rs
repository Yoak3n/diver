//! TTS 播放器事件（后端队列 → 前端播放窗口）。

use serde::Serialize;

/// 后端播放队列推给窗口的事件。`requestId` 对齐一次朗读。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TtsPlayerEvent {
    /// 开始合成/播放（口型可提前开）。
    Start { request_id: String },
    /// 流式 PCM16LE 24kHz mono（base64）。
    Pcm { request_id: String, base64: String },
    /// 整段回退音频。
    Audio {
        request_id: String,
        base64: String,
        mime: String,
    },
    /// 合成结束；前端播完后调 `tts_report_end`。
    SynthDone { request_id: String },
    /// 队列被 force/stop 打断。
    Stopped {},
    /// 朗读态（桌宠口型）。
    Speaking { value: bool },
}

/// 播放器槽位：桌宠优先，主窗口兜底。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerKind {
    Pet,
    Main,
}

impl PlayerKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pet" => Some(Self::Pet),
            "main" => Some(Self::Main),
            _ => None,
        }
    }
}
