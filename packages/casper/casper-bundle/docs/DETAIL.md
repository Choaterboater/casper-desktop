# Casper bundle

Adds the Casper layer to a Casper composition without touching any upstream package.

## What it registers

| Row | Package | Effect |
| --- | --- | --- |
| `mcp-network` | `@deepseek-ai/dsh-mcp-client` | Connects the read-only casper-network-mcp server over stdio and publishes its tools as `mcp__network__*`. |

The server is pinned: `uvx --from casper-network-mcp==0.1.7 casper-network-mcp --read-only`.

## Casper persona

The persona is deliberately **not** in `cordis.patch.yml`. `@deepseek-ai/dsh-persona` needs an agent
scope: mounted globally it collides with the prompt registry's own `deployment:persona-prefix`
registration and fails loud. Mount it inside a preset instead:

```yaml
- id: preset-casper
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: casper
    plugins:
      - name: '@deepseek-ai/dsh-persona'
        config:
          prefix: |
            You are Casper, a terminal coding companion.
```

Set the registry default to select it for new sessions:

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: casper
```

## Not yet wired

- Desktop branding is a separate edit in `apps/desktop/scripts/electron-builder-config.mjs`
  (`productName`, `artifactName`); the reverse-DNS `appId` comes from `DSH_DESKTOP_APP_ID` at build time.
- Casper behaviours beyond identity (checks, delegation, page rendering) each need their own row or
  tool package; they are not part of this bundle yet.
