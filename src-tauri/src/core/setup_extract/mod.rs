//! 依赖归档并行解压：`*.tar.zst` / `*.tar` → 目录。
//!
//! 只做 IO，不依赖 Tauri；进度经回调上抛（调用方负责 emit）。
//! 解读顺序读、写盘扇出到工作线程 —— 首启瓶颈是上万小文件的写入而非解压流本身。
//!
//! 分层：read.rs 读侧判定与解码（纯函数可测）| extract.rs 并行解压与写盘。

mod extract;
mod read;

pub use extract::extract_archive;
