# tabby-better-configer

Structured config management for Tabby — a "Config Manager" tab in the
settings page that shows every section of `config.yaml` grouped by the plugin
that declares it, with per-section YAML editing, validation, and
import/export.

## Features

- **Two-level navigation**: plugin group (Core / Terminal / SSH / … / third-party
  plugins) → config sections (`terminal`, `hotkeys`, `appearance`, …). Sections
  declared by several plugins appear in each group with a `shared` badge.
- **Per-section YAML editor**: current persisted values (exactly what is in
  `config.yaml`) with live YAML validation, side-by-side defaults preview,
  save-and-apply, unsaved-changes discard.
- **Import/export**: sections individually or the whole config, as a
  self-describing JSON package (`.tabby-config.json`) carrying format version,
  export time and Tabby version. Import validates and merges (deep merge for
  objects; `profiles`/`groups` merge by id), or replaces selected sections.
  Sensitive sections (`vault`, `encrypted`, `configSync`) are excluded from
  full exports and require explicit confirmation elsewhere.
- Sections present in `config.yaml` but no longer declared by any installed
  plugin are grouped under "Other" so leftovers become visible.

## Build

```
npm install
npm run build        # webpack → dist/index.js
npm run smoke        # module-level load smoke test
npm run package      # stage release/ + zip
```

## Install

Copy `release/tabby-better-configer/` into Tabby's
`<userData>\plugins\node_modules\` (or `npm run package:install` on this
machine), then fully restart Tabby.

## Debugging

```
node scripts/updateDebugCfg.js   # deploy dist into the sandbox instance
                                 # (test-env\tabby-bc, CDP port 9233; created on
                                 # first run from the portable install)
```

Helper scripts (CDP-driven, `CDP_PORT` env or first arg): `scripts/cdpConsole.js`
(capture renderer console), `scripts/cdpEvalWatch.js` (eval + console watch),
`scripts/cdpHotkey.js` (key chord injection), `scripts/asarProbe.js` (inspect
app.asar). Notes: plugin loads are progressive — wait ~20s after startup before
asserting `window.pluginModules`; a `Page.reload` does NOT re-populate user
plugins (process restart required); never `cp` into the plugins dir with bash
quoted Windows paths — a mangled directory name there silently disables ALL
user plugins.
