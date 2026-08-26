# Releasing BB Official plugins

Official plugins ship **bundled inside the BB app**. There is no separate
publish pipeline: at packaging time, `apps/server/scripts/copy-builtin-plugins.ts`
builds every package declared in `PACKAGED_PLUGINS`
(`apps/server/src/services/plugins/builtin-registry.ts`) and copies each
prebuilt runtime layout into `<server dist>/builtin-plugins/<name>`. The app in
Extensions → Plugins → Browse installs official plugins from that local bundled
copy; no network is involved.

Every packaged plugin-shaped runtime lives in `plugins/<name>`. Its registry
class owns its lifecycle:

- `BUILTIN_PLUGINS` reconcile automatically as user-visible installed plugins.
- `OFFICIAL_PLUGINS` stay in the local store until a user installs them.
- Server-owned packages such as `WORK_TOGETHER_RUNTIME_PLUGIN` are copied with
  the release but never enter the catalog or installed-plugin state. BB loads
  that runtime directly when its server profile requires it.

`BUNDLED_PLUGINS` is the user-visible builtin and official union;
`PACKAGED_PLUGINS` additionally contains hidden server-owned runtime packages.

The official plugins are:

| Directory        | Package name             | Store entry | Plugin id      |
| ---------------- | ------------------------ | ----------- | -------------- |
| `plugins/github` | `bb-plugin-github`       | `github`    | `github`       |
| `plugins/docs`   | `bb-plugin-simple-notes` | `docs`      | `simple-notes` |
| `plugins/memory` | `bb-plugin-memory`       | `memory`    | `memory`       |
| `plugins/tasks`  | `bb-plugin-tasks`        | `tasks`     | `tasks`        |

## Releasing a change

1. Land the plugin change on `main` like any other code change. Bump the
   plugin's `package.json` version when the change is user-visible — the
   version is shown in plugin management and drives startup reconciliation
   (an installed official plugin re-points to the new bundled copy when its
   version or root directory changes).
2. Ship a normal BB app release. The packaging step rebuilds and bundles every
   official plugin automatically; installed plugins pick up the new code at
   the next server start.

Never check in `plugins/*/dist`; packaging builds it.

## Releasing the Work Together Vespyn runtime

`plugins/vespyn-runtime` is required BB backend infrastructure for
`BB_PRINCIPAL_MODE=work-together`. It is not installed, removed, enabled, or
configured through plugin management. Its runtime configuration comes from
`BB_WORK_TOGETHER_COORDINATOR_ORIGIN` and
`BB_WORK_TOGETHER_CELL_TOOL_SECRET`; `/readyz` reports
`checks.vespynRuntime` and requires cell-tool contract version `1`.

Deploy a BB release containing the compatible runtime before deploying a Work
Together release that requires that contract. Reverse that order for rollback.
Do not restore the former `work-together` or `vespyn-agent-toolkit` path-plugin
delivery.

## Adding a new official plugin

1. Create the plugin under `plugins/<name>` with a `bb` manifest
   block (`server`, optional `app`, `branding`, optional `skills`).
2. Add an entry to `OFFICIAL_PLUGINS` in
   `apps/server/src/services/plugins/builtin-registry.ts` with the store
   `name`, the derived `pluginId`, `defaultEnabled`, and a `category` for the
   Browse tab. The registry-invariant test
   (`apps/server/test/services/plugins/official-plugins.test.ts`) verifies the
   declared plugin id matches the manifest.

## Verify locally

```bash
pnpm exec turbo run build --filter=bb-app
ls packages/bb-app/server/dist/builtin-plugins
```

Every bundled plugin directory must contain a rewritten `package.json`
pointing at `./dist/server.js` plus the prebuilt `dist/` artifacts. Then, in a
dev build:

```bash
bb plugin search docs
bb plugin install docs --yes
bb plugin list
bb plugin remove simple-notes
```
