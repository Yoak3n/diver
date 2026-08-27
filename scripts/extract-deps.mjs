// Diver sidecar 依赖解压脚本（随包使用）。
//
// 背景：sidecar 的 node_modules 包含约 1.5 万个小文件，NSIS 逐个写入安装目录
// 极慢。打包时把它们打成 tar 归档（node_modules.tar），安装后本脚本在首次
// 启动 sidecar 前一次性解压（tar.exe 是 Windows 10+ 自带，随包 node 调用）。
//
// 用法（在 sidecar 运行时目录下，由 Rust 侧自动调用，也可手动）：
//   node extract-deps.mjs
//
// 幂等：已解压（marker 存在）则跳过；解压完成写 marker。
// 归档在解压成功后即删除（不再占用安装后磁盘空间）；归档不存在时跳过
// （源码形态 / 开发环境 / 已解压清理）。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const HERE = resolve(import.meta.dirname ?? ".");
const TAR = process.env.DIVER_TAR_BIN || "tar";

// 归档 → 解压目标目录映射（相对 sidecar 根）
const ARCHIVES = [
  { archive: "node_modules.tar", dest: "node_modules" },
  { archive: join("harness", "node_modules.tar"), dest: join("harness", "node_modules") },
  { archive: join("plugins", "node_modules.tar"), dest: join("plugins", "node_modules") },
];

const MARKER = ".deps-extracted";

function log(...m) {
  console.log("[extract-deps]", ...m);
}

async function main() {
  let extracted = 0;
  for (const { archive, dest } of ARCHIVES) {
    const archivePath = join(HERE, archive);
    const destPath = join(HERE, dest);
    const markerPath = join(destPath, MARKER);
    if (!existsSync(archivePath)) {
      // 归档不存在：源码形态（开发环境）或已被解压后清理
      continue;
    }
    if (existsSync(markerPath)) {
      log(`跳过 ${dest}（已解压）`);
      continue;
    }
    log(`解压 ${archive} → ${dest} …`);
    mkdirSync(destPath, { recursive: true });
    try {
      execFileSync(TAR, ["-xf", archivePath, "-C", destPath], { stdio: "inherit" });
      writeFileSync(markerPath, new Date().toISOString(), "utf8");
      // 解压成功即删除归档：它只在「安装后首次解压」这一个环节有用，
      // 留着徒占安装目录磁盘（sidecar/node_modules.tar 等合计上百 MB）。
      rmSync(archivePath, { force: true });
      extracted++;
      log(`  ✓ ${dest} 解压完成（归档已删除）`);
    } catch (e) {
      console.error(`[extract-deps] 解压 ${archive} 失败: ${e.message}`);
      process.exitCode = 1;
    }
  }
  if (extracted === 0 && ARCHIVES.every(({ archive }) => !existsSync(join(HERE, archive)))) {
    log("无归档，跳过（源码形态或已解压清理）");
  }
  log(`完成：解压 ${extracted} 个`);
}

void main();
