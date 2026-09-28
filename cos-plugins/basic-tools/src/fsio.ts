// @diver/basic-tools — 本地文件系统基础层（移植自 DSH 上游 @deepseek-ai/dsh-fs-local，
// Cordis-free 纯 node:fs，无 ctx.fs 服务依赖）。
//
// 与上游的差异（diver 是 Windows 桌面 companion，无沙箱/观测服务）：
// - 错误用 DiverFsError（带稳定 code）而非上游 FsError 词表，message 即模型可见文案；
// - Windows 原子发布简化：rename 覆盖 + chmod 保 mode（上游用 koffi 复制 DACL +
//   ReplaceFileW，普通文本文件场景非必需，避免引入 native 依赖）；
// - 无 fs/observed 观测事件与 fs/write-intent waterfall：守卫语义由调用方
//   （observation 表）实现。
//
// 按职责分文件，本文件只做稳定 re-export：
//   fsio-error.ts   错误码与错误判定
//   fsio-text.ts    文本解码 / 二进制拒绝（read、edit 共用原语）
//   fsio-target.ts  路径解析与存在性探测
//   fsio-read.ts    常规文本读取（整体 / 流式）
//   fsio-write.ts   写入（staging + 原子发布）
//   fsio-edit.ts    编辑（行尾归一 + 字面替换）

export * from './fsio-error.ts'
export * from './fsio-text.ts'
export * from './fsio-target.ts'
export * from './fsio-read.ts'
export * from './fsio-write.ts'
export * from './fsio-edit.ts'
