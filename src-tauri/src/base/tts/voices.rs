//! 内置声线表与服务商可选模型列表。

use crate::config::tts::{TtsConfig, TtsProvider, TtsVoice};

fn mimo_voices() -> Vec<TtsVoice> {
    [
        ("mimo_default", "mimo_default", "zh-CN"),
        ("冰糖", "冰糖 · 活泼少女", "zh-CN"),
        ("茉莉", "茉莉 · 知性女声", "zh-CN"),
        ("苏打", "苏打 · 阳光少年", "zh-CN"),
        ("白桦", "白桦 · 成熟男声", "zh-CN"),
        ("Mia", "Mia", "en-US"),
        ("Chloe", "Chloe", "en-US"),
        ("Milo", "Milo", "en-US"),
        ("Dean", "Dean", "en-US"),
    ]
    .into_iter()
    .map(|(id, name, lang)| TtsVoice {
        id: id.into(),
        name: name.into(),
        lang: lang.into(),
    })
    .collect()
}

fn minimax_voices() -> Vec<TtsVoice> {
    [
        ("female-tianmei", "甜美女声", "zh-CN"),
        ("female-shaonv", "少女音", "zh-CN"),
        ("female-yujie", "御姐音", "zh-CN"),
        ("female-chengshu", "成熟女声", "zh-CN"),
        ("male-qn-qingse", "青涩青年音", "zh-CN"),
        ("male-qn-jingying", "精英青年音", "zh-CN"),
        ("male-qn-badao", "霸道青年音", "zh-CN"),
        ("presenter_female", "女主持人", "zh-CN"),
        ("presenter_male", "男主持人", "zh-CN"),
        (
            "Chinese (Mandarin)_Unrestrained_Young_Man",
            "奔放青年男声",
            "zh-CN",
        ),
    ]
    .into_iter()
    .map(|(id, name, lang)| TtsVoice {
        id: id.into(),
        name: name.into(),
        lang: lang.into(),
    })
    .collect()
}

fn volcengine_voices() -> Vec<TtsVoice> {
    [
        ("zh_female_xiaohe_uranus_bigtts", "小何", "zh-CN"),
        ("zh_female_vv_uranus_bigtts", "薇薇", "zh-CN"),
        ("saturn_zh_female_keainvsheng_tob", "可爱女声", "zh-CN"),
        ("saturn_zh_female_tiaopigongzhu_tob", "调皮公主", "zh-CN"),
        ("saturn_zh_female_cancan_tob", "灿灿", "zh-CN"),
        ("saturn_zh_male_shuanglangshaonian_tob", "爽朗少年", "zh-CN"),
        ("saturn_zh_male_tiancaitongzhuo_tob", "天才同桌", "zh-CN"),
        ("zh_male_taocheng_uranus_bigtts", "陶诚", "zh-CN"),
    ]
    .into_iter()
    .map(|(id, name, lang)| TtsVoice {
        id: id.into(),
        name: name.into(),
        lang: lang.into(),
    })
    .collect()
}

/// 列出当前服务商的声线（内置预设 + 用户自定义 ID）。
pub fn list_voices(cfg: &TtsConfig) -> Vec<TtsVoice> {
    let mut voices = match cfg.provider {
        TtsProvider::Mimo => mimo_voices(),
        TtsProvider::Minimax => minimax_voices(),
        TtsProvider::Volcengine => volcengine_voices(),
    };
    for id in &cfg.custom_voices {
        if voices.iter().any(|v| &v.id == id) {
            continue;
        }
        voices.push(TtsVoice {
            id: id.clone(),
            name: id.clone(),
            lang: "zh-CN".into(),
        });
    }
    voices
}

/// 当前服务商可选模型（advisory）。
pub fn list_models(provider: TtsProvider) -> Vec<String> {
    match provider {
        TtsProvider::Mimo => vec![
            "mimo-v2.5-tts".into(),
            "mimo-v2.5-tts-voicedesign".into(),
            "mimo-v2.5-tts-voiceclone".into(),
        ],
        TtsProvider::Minimax => vec![
            "speech-02-hd".into(),
            "speech-02-turbo".into(),
            "speech-01".into(),
            "speech-01-240228".into(),
        ],
        TtsProvider::Volcengine => Vec::new(),
    }
}
