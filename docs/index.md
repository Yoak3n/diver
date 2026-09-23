# Diver 文档中心

Diver 是基于 **Tauri 2 + Vue 3 + DeepSeek Harness** 的桌面陪伴 agent。
本目录按主题组织项目文档，README.md 是入口，各主题的深入内容见下。

## 快速开始

- [README](../README.md) - 项目简介、快速开始、架构总览
- [开发指南](development.md) - 环境要求、运行、调试、冒烟测试
- [Agent / 维护者约定](../AGENTS.md) - **Rust 代码组织硬性规范**：文件长度、分层、解耦与单测约束

## 架构

- [总体架构](architecture.md) - 三层架构（Rust 壳 / Vue UI / Node sidecar）、进程拓扑、启动时序、窗口管理
- [Node sidecar 与 cos 接入](sidecar.md) - cos harness 进程生命周期、loader 参数、会话持久化
- [插件体系与生命周期](plugins.md) - **插件权威契约**：loader 组合、profile 启停、壳端管理、深水区分期
- [对照 DSH / harness-desktop](plugins-upstream-comparison.md) - 概念映射、生命周期操作差、有意差异与各期借鉴清单
- [通信通道收敛](channels.md) - invoke / backend SSE / `/rpc` 分工；能否用事件面替代 RPC

## 功能模块

- [Live2D 桌宠](live2d-pet.md) - 桌宠渲染、交互、口型同步、窗口技术
- [模型提供商](providers.md) - 插件声明驱动的配置体系、deepseek-official / opencode-go、端点路由
- [关系层记忆](memory.md) - Node 提取插件 + Rust SQLite 后端、JSON-RPC 协议、衰减/激活/遗忘机制

## 规划

- [Windows 分发](distribution.md) - NSIS 安装包、不随包 Node（首启解析/下载）运行时布局、插件开放目录
- [打包与路线图](roadmap.md) - 已知限制、打包分发策略、后续方向（插件深水区见 plugins.md）
