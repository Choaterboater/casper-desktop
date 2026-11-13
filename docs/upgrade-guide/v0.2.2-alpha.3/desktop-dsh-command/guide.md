---
kind: upgrade-guide
description: "The dsh command a Casper desktop installation provides only manages the desktop profile's plugins; every other profile needs the npm CLI."
---

# Desktop's dsh command only manages Desktop plugins

English | [中文](guide.zh.md)

## Change

Previously, the `dsh` command that **Manage dsh Command…** registers ran the shared CLI with Desktop's runtime, so it could also boot profiles such as `web` and `headless`, dump configuration, and manage other profiles' plugins. Now it accepts only three forms:

- `dsh plugin --profile desktop <pnpm arguments...>`, such as `add <package>`, `list`, or `remove <package>`;
- `dsh --version`;
- `dsh --help`, which prints this command's own help.

Every other invocation, including `dsh web`, `dsh headless`, `--dump-config`, and `dsh plugin --profile <other>`, exits with status 1 and names the npm CLI's install command, `npm install -g @deepseek-ai/dsh`. The npm CLI ships every profile. Desktop's package set also leaves out the upstream profile bundles other than `dsh-web-app`.

This affects anyone who runs profiles other than `desktop` through the command Desktop registers. Profiles under `$DSH_HOME/profiles` and their data are unchanged.

## Migration

1. Install the npm CLI with `npm install -g @deepseek-ai/dsh`. Confirm: `npm ls -g @deepseek-ai/dsh` lists the package.
2. Put the npm CLI first on PATH when both commands are installed. Desktop's command is `/usr/local/bin/dsh` on macOS; on Windows, Desktop registers it in the current user's PATH. Alternatively, choose **Manage dsh Command… → Remove** in Desktop. Confirm: in a new terminal, `dsh --help` does not print "This dsh command is installed by Casper".
3. Manage Desktop plugins with Desktop's command, because the npm CLI rejects plugin management for the `desktop` profile. When the npm CLI comes first on PATH, run Desktop's command by its full path, `/usr/local/bin/dsh` on macOS or `resources\runtime\cli\bin\dsh.cmd` in the Desktop installation directory on Windows. Quit Desktop first. Confirm: `dsh plugin --profile desktop list` through that command lists the desktop profile's packages.
4. Point scripts that run other profiles at the npm CLI. Confirm: none of them exits with the message that names `npm install -g @deepseek-ai/dsh`.
