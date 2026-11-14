---
kind: upgrade-guide
description: "Requests name Casper desktop instead of the upstream harness, Desktop plugin installs and file reads never use npmmirror, Session upload has no built-in collector, and production update packaging needs its own origin."
---

# Requests name Casper desktop and use no upstream service by default

## Change

- Every model provider request and every web fetch sends `User-Agent: casper-desktop/<version> (+https://github.com/Choaterboater/casper-desktop)`, the Codex subagent introduces itself to `codex app-server` as `casper-desktop`, and Session upload records carry the OTel resource `service.name: casper-desktop`. Previously all three named the upstream harness. Provider filters, logs or collector queries that match the old product token see the new one.
- The Desktop profile no longer times the npm registry against `registry.npmmirror.com` (`ui-plugin-manager` `registryProbeEnabled: false`), no longer retries a failed plugin install against npmmirror (`plugin-manager` `fallbackRegistries: []`), and reads plugin READMEs and images from jsdelivr and unpkg only (`plugin-manager` `detailNpmFileSources: [jsdelivr, unpkg]`). A registry the person picks in the install dialog still applies.
- Session upload (`DSH_TELEMETRY_MODE`) has no built-in collector in any profile. Opting in without `DSH_TELEMETRY_OTLP_URL` now stops the `session-telemetry-otel` plugin from loading; previously it sent to the upstream collector.
- Production Desktop packaging and upload read the update origin from `DOWNLOAD_PROD_ORIGIN`; there is no fixed production origin, and `publishing/production.json` accepts any HTTPS origin.

## Migration

1. If plugin installs need a mirror, pick it in the install dialog, or set `fallbackRegistries` (and `detailNpmFileSources`) on the `plugin-manager` row of your profile's `cordis.yml`. Confirm: the install dialog names the registry you chose.
2. If you opt in to Session upload, set `DSH_TELEMETRY_OTLP_URL` to your collector's full OTLP logs URL. Confirm: the process starts without `exporter.url is required`.
3. For production update packaging, set `DOWNLOAD_PROD_ORIGIN=https://<your download host>` in `apps/desktop/.env.macos` or `apps/desktop/.env.windows`, or in `$DSH_PACKAGING_CONFIG_DIR/presets/production.env` with `DSH_PACKAGING_PRESET=production`; CI publishing takes it from `origin` in `publishing/production.json`. Confirm: packaging no longer fails with `DOWNLOAD_PROD_ORIGIN must be set`.
