# Casper

This is the desktop app of [Casper](https://github.com/Choaterboater/casper), published by Choaterboater. It is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`, MIT) and is not an official DeepSeek product.

New sessions start in **Casper mode**, which runs the real Casper CLI over ACP (`casper acp`): Casper's own agent loop, models and checks (record, replay, never report a check that did not run as passed), with its approval boxes, questions, plans and receipt shown as the app's cards. The harness's own agent loop stays available as Standard mode. The app also ships the read-only casper-network-mcp server, and sends nothing to DeepSeek unless you add it as a model provider.

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

## Developer preview

Casper is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

Pull requests and pushes to `main` run [Casper CI](.github/workflows/casper-ci.yml) on GitHub's own runners: static gates, typecheck, lint and the unit tests. GitHub runs every workflow file in `.github/workflows`, so Casper CI is the only one there, and [a unit test](scripts/casper-workflows.spec.ts) fails while that folder holds any other. Upstream's workflows need upstream's secrets and runners, so this repository does not keep them: when an upstream merge adds a workflow file, delete it before pushing the merge branch, because GitHub runs a workflow that a pull request adds on that pull request.

Documentation is in English only; the app's own screen text still ships in 8 locales.

Casper CI also scans what the desktop app ships. [A unit test](scripts/casper-desktop-shipped.spec.ts) walks the packager's own package set and fails on an upstream or npm-mirror host, upstream product text in any of the 8 locales, upstream's short product names (DSH, Harness) in a locale dictionary, an upstream service package or row, or an import of one. The findings it accepts are listed in [the rules](scripts/casper/desktop-shipped-rules.ts), each with its reason and an exact count; they are upstream-only copy the desktop never shows, npm-mirror constants it switches off, the pi-ai model catalog, a link in a doc comment of the OpenTelemetry attribute list, and the About credit. The test reads sources, not build output, so to check a packaged app locally, run `pnpm exec tsx scripts/casper/scan-packaged-app.ts <Casper.app> --target darwin-arm64`.

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
