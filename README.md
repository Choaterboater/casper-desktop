# Casper

English | [中文](README.zh.md)

This is the desktop app of [Casper](https://github.com/Choaterboater/casper), published by Choaterboater. It is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`, MIT), the open-source agent harness developed by [DeepSeek AI](https://deepseek.com); it is not an official DeepSeek product.

New sessions start in **Casper mode**, which runs the real Casper CLI over ACP (`casper acp`): Casper's own agent loop, models and checks (record, replay, never report a check that did not run as passed), with its approval boxes, questions, plans and receipt shown as the app's cards. The harness's own agent loop stays available as Standard mode. The app also ships the read-only casper-network-mcp server, and sends nothing to DeepSeek unless you add DeepSeek as a model provider.

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Harness documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

Casper and the DeepSeek Harness it builds on are in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

<a id="run-from-source"></a>

### Desktop app

Install `Node.js` 24.9 or later and the [Casper CLI](https://github.com/Choaterboater/casper#install), then run:

```sh
git clone https://github.com/Choaterboater/casper-desktop.git
cd casper-desktop
npx pnpm@11.28.5 install
npx pnpm@11.28.5 run build
npx pnpm@11.28.5 run start:desktop
```

The app looks for `casper` on `PATH` and in `~/.local/bin`, and opens straight into a Casper session. Casper mode exists only in the desktop app. The desktop app is tested on macOS; Windows is not tested yet.

### Web UI

After the build, `npx pnpm@11.28.5 dsh web` starts the Web UI at `http://127.0.0.1:3080`. It offers the harness's own Standard mode, not Casper mode. See [Web UI guide](docs/user/guide/index.md).

## Community and support

- Report Casper desktop bugs in [GitHub Issues](https://github.com/Choaterboater/casper-desktop/issues), and Casper CLI bugs in the [Casper repository](https://github.com/Choaterboater/casper/issues).
- Questions about the harness itself belong upstream: [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) and its <a href="https://discord.gg/4MrtZUhpxg">Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

Pull requests and pushes to `main` run [Casper CI](.github/workflows/casper-ci.yml) on GitHub's own runners: static gates, typecheck, lint and the unit tests. GitHub runs every workflow file in `.github/workflows`, so Casper CI is the only one there, and [a unit test](scripts/casper-workflows.spec.ts) fails while that folder holds any other. Upstream's workflows need upstream's secrets and runners, so they are kept unedited in `.github/upstream-workflows`, where GitHub never runs them. When an upstream merge adds a workflow file, move it to `.github/upstream-workflows` before pushing the merge branch, because GitHub runs a workflow that a pull request adds on that pull request.

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
