//! 音频 MIME / hex 解码等纯工具。

pub(super) fn mime_of(format: &str) -> &'static str {
    match format {
        "wav" => "audio/wav",
        _ => "audio/mpeg",
    }
}

pub(super) fn decode_hex_audio(hex: &str) -> Result<Vec<u8>, String> {
    let clean = hex.trim().trim_start_matches("0x").replace(' ', "");
    let padded = if clean.len() % 2 == 0 {
        clean
    } else {
        format!("0{clean}")
    };
    if !padded.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("MiniMax 返回的音频不是合法 hex".into());
    }
    let bytes: Result<Vec<u8>, _> = (0..padded.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&padded[i..i + 2], 16))
        .collect();
    bytes.map_err(|e| format!("hex 解码失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_of_wav_and_default() {
        assert_eq!(mime_of("wav"), "audio/wav");
        assert_eq!(mime_of("mp3"), "audio/mpeg");
        assert_eq!(mime_of(""), "audio/mpeg");
    }

    #[test]
    fn decode_hex_audio_strips_prefix_space_and_odd() {
        assert_eq!(decode_hex_audio("0x0A FF").unwrap(), vec![0x0a, 0xff]);
        assert_eq!(decode_hex_audio("F").unwrap(), vec![0x0f]);
        assert_eq!(decode_hex_audio("ff").unwrap(), vec![0xff]);
    }

    #[test]
    fn decode_hex_audio_rejects_non_hex() {
        assert!(decode_hex_audio("zz").is_err());
        assert!(decode_hex_audio("0x").is_ok() || decode_hex_audio("0x").unwrap().is_empty());
    }
}
