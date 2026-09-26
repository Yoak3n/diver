// dev 专用 vite 启动器：唯一职责是把 libuv 线程池调大后再拉起 vite。
//
// 为什么：libuv 线程池默认仅 4 线程，Windows 上启动期 chokidar 初始扫描、
// warmup 预热、转换里的文件读取会把它占满，模块转换排队实测出现 10~20s 的
// 白屏尾巴（vite:transform 显示 style.css 19.6s、App.vue 3.3s，小文件
// [fs] 读取 1.8s 集体完成）。调大后 dev 全图加载 11.6s → 4.5s。
// UV_THREADPOOL_SIZE 必须在 node 进程启动前生效，因此由本进程注入 env
// 再 spawn vite 子进程（本进程自身不做 fs 工作，不受默认值影响）。
process.env.UV_THREADPOOL_SIZE ??= "64";

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const viteBin = join(root, "node_modules", "vite", "bin", "vite.js");
const child = spawn(process.execPath, [viteBin, ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
