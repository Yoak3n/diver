//! 归档读侧：格式判定 / 路径消毒（纯函数）/ 解码器选择。

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

/// zstd 帧魔数（`28 B5 2F FD`）。
pub(super) fn is_zstd_magic(head: &[u8]) -> bool {
    head.len() >= 4 && head[0] == 0x28 && head[1] == 0xB5 && head[2] == 0x2F && head[3] == 0xFD
}

/// 归档条目路径消毒：只保留普通相对路径，拒绝绝对路径 / 盘符 / `..` 穿越
/// （与 tar crate `unpack_in` 的防护语义一致）。
pub(super) fn sanitize_entry_path(raw: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for comp in raw.components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// 按魔数选择解码器：zstd 帧 → 解压流；否则原样（未压缩 tar）。
pub(super) fn open_reader(archive: &Path) -> Result<Box<dyn Read + Send>, String> {
    let mut file = File::open(archive).map_err(|e| format!("打开 {}: {e}", archive.display()))?;
    let mut head = [0u8; 4];
    let n = file
        .read(&mut head)
        .map_err(|e| format!("读取 {}: {e}", archive.display()))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("重置 {}: {e}", archive.display()))?;
    if is_zstd_magic(&head[..n]) {
        let dec = zstd::Decoder::new(file).map_err(|e| format!("zstd 解码 {}: {e}", archive.display()))?;
        Ok(Box::new(dec))
    } else {
        Ok(Box::new(file))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zstd_magic_detection() {
        assert!(is_zstd_magic(&[0x28, 0xB5, 0x2F, 0xFD, 0x00]));
        assert!(!is_zstd_magic(&[0x1F, 0x8B, 0x08, 0x00]));
        assert!(!is_zstd_magic(&[0x28]));
    }

    #[test]
    fn sanitize_rejects_traversal() {
        assert_eq!(
            sanitize_entry_path(Path::new("a/b.txt")),
            Some(PathBuf::from("a").join("b.txt"))
        );
        assert_eq!(sanitize_entry_path(Path::new("./a")), Some(PathBuf::from("a")));
        assert_eq!(sanitize_entry_path(Path::new("../evil")), None);
        assert_eq!(sanitize_entry_path(Path::new("a/../../evil")), None);
        assert_eq!(sanitize_entry_path(Path::new("/abs")), None);
        assert_eq!(sanitize_entry_path(Path::new("")), None);
    }
}
