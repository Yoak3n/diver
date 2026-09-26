import { defineConfig, type Plugin } from "vite";
import vue from "@vitejs/plugin-vue";

// @ts-expect-error node builtin; 本工作区无 @types/node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
// @ts-expect-error node builtin; 本工作区无 @types/node
import { dirname, join } from "node:path";
// @ts-expect-error node builtin; 本工作区无 @types/node
import { monitorEventLoopDelay } from "node:perf_hooks";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
const sidecarPort = Number(process.env.DIVER_PORT ?? 53620);

/**
 * dev 诊断：逐请求服务记账（到达时刻 + 服务耗时 + endGap → node_modules/.vite/request.log）。
 * - endGap = finish − res.end 被调用的时刻：≈0 表示 handler 算完立刻写出（等待在 handler 内），
 *   很大表示 res.end 早已调用但 socket 迟迟 flush（客户端不读/背压）。
 * - `#loop` 行：500ms 采样的事件循环延迟 p99/max，识别 node 同步阻塞窗口。
 * 用途：定位启动白屏里「页面加载慢」落在哪一层（vite handler / socket / 客户端）。
 */
function requestLog(): Plugin {
  const logPath = join(process.cwd(), "node_modules", ".vite", "request.log");
  return {
    name: "diver-request-log",
    configureServer(server) {
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, `# vite boot ${new Date().toISOString()}\n`);
      const eld = monitorEventLoopDelay({ resolution: 20 });
      eld.enable();
      const timer = setInterval(() => {
        const p99 = eld.percentile(99) / 1e6;
        const max = eld.max / 1e6;
        if (p99 > 50 || max > 200) {
          appendFileSync(
            logPath,
            `# loop p99=${p99.toFixed(0)}ms max=${max.toFixed(0)}ms at ${new Date().toISOString()}\n`,
          );
        }
        eld.reset();
      }, 500);
      timer.unref?.();
      server.middlewares.use((req, res, next) => {
        const t0 = Date.now();
        let endCalledAt = 0;
        const origEnd = res.end.bind(res) as typeof res.end;
        res.end = (...args: unknown[]) => {
          endCalledAt = Date.now();
          // @ts-expect-error 透传重载参数
          return origEnd(...args);
        };
        res.on("finish", () => {
          const dur = Date.now() - t0;
          const gap = endCalledAt ? Date.now() - endCalledAt : -1;
          const line = `${new Date(t0).toISOString()} +${String(dur).padStart(5)}ms endGap=${String(gap).padStart(5)}ms ${res.statusCode} ${req.method} ${req.url}\n`;
          appendFileSync(logPath, line);
        });
        next();
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), requestLog()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // 显式绑 IPv4：host:false 会经 "localhost" 解析落到仅 [::1]（netstat 证实），
    // WebView2 网络服务对 localhost/IPv6 的解析回退疑似拖慢首屏连接（冷启 7s 停顿）。
    host: host || "127.0.0.1",
    warmup: {
      // 启动即预热整个 src 模块图（含懒加载视图），挪到窗口打开前的空闲期完成：
      // WebView2 冷启动的几秒里转换已就绪，开窗后全部 304 秒回。
      // CSS 伪模块（?vue&type=style）不匹配 glob，但预转换 .vue 时
      // import-analysis 会以 fire-and-forget 方式连带预热它们。
      // 最后一个条目是 @vite/client 的依赖 env.mjs：它是全图唯一漏网、首转换
      // 落在应用启动风暴窗口（sidecar/WebView2/Defender 抢 CPU）的文件，
      // 实测该窗口内一次首转换 6.6s，页面因此整体冻结到它完成。
      clientFiles: [
        "./index.html",
        "./src/**/*",
        "./node_modules/vite/dist/client/env.mjs",
      ],
    },
    proxy: {
      // dev 模式下 /api 转发到 sidecar（与 release 同源行为保持一致）
      "/api": {
        target: `http://127.0.0.1:${sidecarPort}`,
        changeOrigin: true,
      },
    },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 前端不依赖这些目录的 HMR：缩小 chokidar 扫描范围，降低启动期 fs 压力
      // （配合 scripts/dev-vite.mjs 的线程池调大，见该文件说明）。
      ignored: [
        "**/src-tauri/**",
        "**/harness/**",
        "**/cos-plugins/**",
        "**/public/**",
        "**/crates/**",
        "**/dist/**",
      ],
    },
  },
  // 依赖扫描不闩住请求：缓存（_metadata.json）已在时代价可控，
  // 否则首屏 main.ts 会被爬取完成的时刻卡住（实测 7.8s）。
  optimizeDeps: {
    holdUntilCrawlEnd: false,
  },
  // 内联空 postcss 配置：跳过磁盘上的配置查找（resolvePostcssConfig）。
  // 项目本就无 postcss 配置（行为等价），但查找是所有首个 CSS 编译共享 await 的
  // 串行闸——应用启动期 sidecar/WebView2/Defender 抢 IO 时实测被拖到 7.5s，
  // 期间全部 CSS 请求同时扣住、同时放行（模块图因此冻结）。
  css: {
    postcss: {},
  },
  build: {
    // 单入口 SPA：主界面与桌宠通过 vue-router 路由（/#/ 和 /#/pet）区分，
    // 不再需要 pet.html 独立入口。public/pet/ 下的 Live2D 静态资源仍复制到 dist/pet/。
  },
}));
