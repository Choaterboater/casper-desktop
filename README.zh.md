# Casper

[English](README.md) | 中文

这是 [Casper](https://github.com/Choaterboater/casper) 的桌面应用，由 Choaterboater 发布。它构建于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，MIT 许可）之上，后者是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）；本项目并非 DeepSeek 官方产品。

新会话默认使用 **Casper 模式**：通过 ACP 运行真正的 Casper CLI（`casper acp`），即 Casper 自己的智能体循环、模型与检查（记录、重放，从不把没有运行的检查报告为通过），其审批框、提问、计划与回执以应用卡片显示。harness 自带的智能体循环仍可作为 Standard 模式使用。应用还内置只读的 casper-network-mcp 服务器；除非你把 DeepSeek 添加为模型提供方，否则不会向 DeepSeek 发送任何内容。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

Harness 文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

Casper 及其所基于的 DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

<a id="run"></a>

## 运行

<a id="run-from-source"></a>

### 桌面应用

安装 `Node.js` 24.9 或更高版本以及 [Casper CLI](https://github.com/Choaterboater/casper#install)，然后运行：

```sh
git clone https://github.com/Choaterboater/casper-desktop.git
cd casper-desktop
npx pnpm@11.28.5 install
npx pnpm@11.28.5 run build
npx pnpm@11.28.5 run start:desktop
```

应用会在 `PATH` 和 `~/.local/bin` 中查找 `casper`，启动后直接进入 Casper 会话。Casper 模式只在桌面应用中提供。桌面应用已在 macOS 上测试；Windows 尚未测试。

### Web UI

构建完成后，`npx pnpm@11.28.5 dsh web` 会在 `http://127.0.0.1:3080` 启动 Web UI。它提供 harness 自带的 Standard 模式，而不是 Casper 模式。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

## 社区与支持

- 在 [GitHub Issues](https://github.com/Choaterboater/casper-desktop/issues) 报告 Casper 桌面应用的问题，在 [Casper 仓库](https://github.com/Choaterboater/casper/issues) 报告 Casper CLI 的问题。
- 关于 harness 本身的问题请到上游：[DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 及其 <a href="https://discord.gg/4MrtZUhpxg">Discord 社区</a>。

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

拉取请求和推送到 `main` 的提交会在 GitHub 自带的 runner 上运行 [Casper CI](.github/workflows/casper-ci.yml)：静态检查、类型检查、lint 与单元测试。GitHub 会运行 `.github/workflows` 中的每个 workflow 文件，因此该目录只放 Casper CI；只要该目录中还有其他 workflow 文件，[一个单元测试](scripts/casper-workflows.spec.ts)就会失败。上游的 workflow 需要上游的密钥和 runner，因此原样保存在 `.github/upstream-workflows` 中，GitHub 不会运行那里的文件。上游合并新增 workflow 文件时，请在推送合并分支之前把它移到 `.github/upstream-workflows`，因为拉取请求新增的 workflow 会在该拉取请求上运行。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
