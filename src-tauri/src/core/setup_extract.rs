//! 依赖归档并行解压：`*.tar.zst` / `*.tar` → 目录。
//!
//! 只做 IO，不依赖 Tauri；进度经回调上抛（调用方负责 emit）。
//! 解读顺序读、写盘扇出到工作线程 —— 首启瓶颈是上万小文件的写入而非解压流本身。

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

/// zstd 帧魔数（`28 B5 2F FD`）。
fn is_zstd_magic(head: &[u8]) -> bool {
    head.len() >= 4 && head[0] == 0x28 && head[1] == 0xB5 && head[2] == 0x2F && head[3] == 0xFD
}

/// 归档条目路径消毒：只保留普通相对路径，拒绝绝对路径 / 盘符 / `..` 穿越
/// （与 tar crate `unpack_in` 的防护语义一致）。
fn sanitize_entry_path(raw: &Path) -> Option<PathBuf> {
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
fn open_reader(archive: &Path) -> Result<Box<dyn Read + Send>, String> {
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

struct WriteJob {
    rel: PathBuf,
    /// `Some`=普通文件内容；`None`=目录。
    data: Option<Vec<u8>>,
}

/// 解压归档到 `dest`，写盘并行；`on_progress(done, total)` 每 40 项回调一次。
pub fn extract_archive(
    archive: &Path,
    dest: &Path,
    on_progress: &mut dyn FnMut(u32, u32),
) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("创建 {}: {e}", dest.display()))?;

    // 先数条目（独立读一遍，避免把整个归档读进内存）；回调一次 0/total 汇报总量
    let total = {
        let reader = open_reader(archive)?;
        let mut ar = tar::Archive::new(reader);
        ar.entries()
            .map_err(|e| format!("读取 tar: {e}"))?
            .filter_map(|e| e.ok())
            .count() as u32
    }
    .max(1);
    on_progress(0, total);

    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(4, 16);
    let (tx, rx) = mpsc::sync_channel::<WriteJob>(256);
    let rx = Arc::new(Mutex::new(rx));
    let errors: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let mut handles = Vec::new();
    for _ in 0..workers {
        let rx = Arc::clone(&rx);
        let errors = Arc::clone(&errors);
        let dest = dest.to_path_buf();
        handles.push(std::thread::spawn(move || {
            let mut last_parent: Option<PathBuf> = None;
            loop {
                let job = match rx.lock().unwrap().recv() {
                    Ok(j) => j,
                    Err(_) => break,
                };
                let target = dest.join(&job.rel);
                let result = match &job.data {
                    Some(data) => {
                        if let Some(parent) = target.parent() {
                            // tar 条目按目录聚簇：记住上一个父目录，省重复 create_dir_all
                            if last_parent.as_deref() != Some(parent) {
                                let _ = fs::create_dir_all(parent);
                                last_parent = Some(parent.to_path_buf());
                            }
                        }
                        fs::write(&target, data).map_err(|e| format!("写入 {}: {e}", target.display()))
                    }
                    None => fs::create_dir_all(&target).map_err(|e| format!("创建 {}: {e}", target.display())),
                };
                if let Err(e) = result {
                    errors.lock().unwrap().push(e);
                }
            }
        }));
    }

    let reader = open_reader(archive)?;
    let mut ar = tar::Archive::new(reader);
    let mut n: u32 = 0;
    for entry in ar.entries().map_err(|e| format!("读取 tar: {e}"))? {
        let mut entry = entry.map_err(|e| format!("tar 条目: {e}"))?;
        let raw = entry
            .path()
            .map_err(|e| format!("tar 路径: {e}"))?
            .into_owned();
        let Some(rel) = sanitize_entry_path(&raw) else {
            continue;
        };
        let job = match entry.header().entry_type() {
            tar::EntryType::Directory => WriteJob { rel, data: None },
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                let mut data = Vec::with_capacity(entry.size() as usize);
                entry
                    .read_to_end(&mut data)
                    .map_err(|e| format!("读取 tar 条目: {e}"))?;
                WriteJob { rel, data: Some(data) }
            }
            // 解引用后的归档不含链接；其余类型跳过
            _ => continue,
        };
        tx.send(job).map_err(|e| format!("分发写入任务: {e}"))?;
        n += 1;
        if n % 40 == 0 {
            on_progress(n, total);
        }
    }
    drop(tx);
    for h in handles {
        let _ = h.join();
    }
    on_progress(n, total);

    let errs = errors.lock().unwrap();
    if errs.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "解压 {} 失败（{} 处）: {}",
            archive.display(),
            errs.len(),
            errs[0]
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("diver-extract-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn build_tar_bytes() -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        let mut h = tar::Header::new_gnu();
        h.set_entry_type(tar::EntryType::Directory);
        h.set_size(0);
        h.set_mode(0o755);
        h.set_cksum();
        builder.append_data(&mut h, "pkg", &[] as &[u8]).unwrap();
        let mut h = tar::Header::new_gnu();
        h.set_size(3);
        h.set_mode(0o644);
        h.set_cksum();
        builder.append_data(&mut h, "pkg/hello.txt", &b"abc"[..]).unwrap();
        builder.into_inner().unwrap()
    }

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

    #[test]
    fn extracts_plain_tar() {
        let dir = scratch("plain");
        let archive = dir.join("t.tar");
        fs::write(&archive, build_tar_bytes()).unwrap();
        let dest = dir.join("out");
        let mut calls = 0u32;
        extract_archive(&archive, &dest, &mut |_, _| calls += 1).unwrap();
        assert!(calls > 0);
        assert_eq!(fs::read_to_string(dest.join("pkg").join("hello.txt")).unwrap(), "abc");
        assert!(dest.join("pkg").is_dir());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extracts_zstd_tar() {
        let dir = scratch("zst");
        let archive = dir.join("t.tar.zst");
        let compressed = zstd::encode_all(&build_tar_bytes()[..], 0).unwrap();
        fs::write(&archive, compressed).unwrap();
        let dest = dir.join("out");
        extract_archive(&archive, &dest, &mut |_, _| {}).unwrap();
        assert_eq!(fs::read_to_string(dest.join("pkg").join("hello.txt")).unwrap(), "abc");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 手工构造 ustar 条目（`tar::Builder` 拒绝写 `..` 路径，无法用来造恶意归档）。
    fn raw_entry(name: &str, data: &[u8]) -> Vec<u8> {
        let mut h = vec![0u8; 512];
        let nb = name.as_bytes();
        h[..nb.len()].copy_from_slice(nb);
        h[100..107].copy_from_slice(b"0000644");
        let size = format!("{:011o}", data.len());
        h[124..124 + size.len()].copy_from_slice(size.as_bytes());
        h[156] = b'0';
        h[257..262].copy_from_slice(b"ustar");
        h[263..265].copy_from_slice(b"00");
        h[148..156].copy_from_slice(b"        ");
        let sum: u32 = h.iter().map(|&b| b as u32).sum();
        let chk = format!("{sum:06o}\0 ");
        h[148..156].copy_from_slice(chk.as_bytes());
        let mut out = h;
        out.extend_from_slice(data);
        let pad = (512 - data.len() % 512) % 512;
        out.extend(std::iter::repeat(0u8).take(pad));
        out
    }

    #[test]
    fn skips_traversal_entries() {
        let dir = scratch("traversal");
        let archive = dir.join("t.tar");
        let mut bytes = raw_entry("../evil.txt", b"bad");
        bytes.extend_from_slice(&raw_entry("ok.txt", b"ok"));
        bytes.extend_from_slice(&[0u8; 1024]);
        fs::write(&archive, bytes).unwrap();
        let dest = dir.join("out");
        extract_archive(&archive, &dest, &mut |_, _| {}).unwrap();
        assert!(!dir.join("evil.txt").exists());
        assert!(!dest.join("evil.txt").exists());
        assert_eq!(fs::read_to_string(dest.join("ok.txt")).unwrap(), "ok");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 手动基准（不进 CI）：对真实 sidecar 归档计时解压。
    /// `DIVER_BENCH_DIR=<sidecar目录> cargo test -p diver --release -- --ignored bench_real_archives --nocapture`
    #[test]
    #[ignore]
    fn bench_real_archives() {
        let Ok(base) = std::env::var("DIVER_BENCH_DIR") else {
            eprintln!("skip: 未设置 DIVER_BENCH_DIR");
            return;
        };
        let base = PathBuf::from(base);
        for (dir, name) in [("harness", "node_modules"), ("plugins", "node_modules")] {
            let parent = base.join(dir);
            let zst = parent.join(format!("{name}.tar.zst"));
            let plain = parent.join(format!("{name}.tar"));
            let archive = if zst.is_file() { zst } else { plain };
            if !archive.is_file() {
                eprintln!("skip: {} 不存在", archive.display());
                continue;
            }
            let dest = scratch("bench").join(name);
            let t0 = std::time::Instant::now();
            let mut done = 0u32;
            extract_archive(&archive, &dest, &mut |n, _| done = n).unwrap();
            println!(
                "bench {}: {} 条目, {:?} ({} MB)",
                dir,
                done,
                t0.elapsed(),
                fs::metadata(&archive).unwrap().len() / 1024 / 1024
            );
            let _ = fs::remove_dir_all(dest.parent().unwrap());
        }
        // 双归档并发口径（与 setup_progress 的首启路径一致）
        let bench_root = scratch("bench-par");
        let pairs: Vec<_> = [("harness", "node_modules"), ("plugins", "node_modules")]
            .iter()
            .filter_map(|(dir, name)| {
                let parent = base.join(dir);
                let zst = parent.join(format!("{name}.tar.zst"));
                let plain = parent.join(format!("{name}.tar"));
                let archive = if zst.is_file() {
                    zst
                } else if plain.is_file() {
                    plain
                } else {
                    return None;
                };
                Some((archive, bench_root.join(dir)))
            })
            .collect();
        let t0 = std::time::Instant::now();
        let mut handles = Vec::new();
        for (archive, dest) in pairs {
            handles.push(std::thread::spawn(move || {
                extract_archive(&archive, &dest, &mut |_, _| {}).unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        println!("bench 并发双归档: {:?}", t0.elapsed());
        let _ = fs::remove_dir_all(&bench_root);
    }
}
