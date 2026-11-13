# Contributing to Host Metrics

## Development

```bash
npm run build      # build into dist/
npm run test       # run this plugin's tests
npm run typecheck  # type-check this plugin
npm run validate   # check manifest.json
npm run pack       # pack the normal plugin (replaces the official plugin if installed)
npm run pack:dev   # test/build/pack a separate host-dev-metrics plugin
npm run format     # format the code with Prettier
```

`npm run pack:dev` follows the UPS Manager development-package workflow:
copy source to temporary staging,
namespace plugin IDs, API routes, permissions, services, sync entities and
database identifiers, then test, type-check, build, validate and pack.
It removes legacy-table adoption in staging and generates fresh development-only
migrations. A database isolation check verifies existing official and legacy
tables are untouched. The staging suite excludes the production legacy-upgrade
tests; run `npm test -- --maxWorkers=2` in the source checkout to cover those.
It does not modify the source manifest or the installed official plugin.
The package is named `host-dev-metrics-1.5.0-dev.hl24.2.tmxplug`.
The ID puts `dev` between `host` and `metrics` because Termix rejects plugin
IDs whose database namespace prefixes overlap, such as `host-metrics-dev`.

Install the development package only with the server administrator's approval.
It appears as **Host Metrics dev** and keeps separate settings, layouts and
history; official-plugin data is not adopted. Existing third-party manager
cards targeting the official plugin's slots do not appear in the isolated
development plugin. Avoid viewing both metric tabs at once on small hosts,
since their independent collectors can add SSH load.
Host-level metrics enablement and enabled-widget flags are still shared core
host properties; test layout changes on a dedicated host.

SQLite tests cover populated pre-swap history upgrades and fresh installs.
The generated MySQL/PostgreSQL migrations require live-database validation
before claiming runtime compatibility on those engines.

## Docs

The docs for this plugin are in [docs/](docs/) and are published at https://docs.termix.site/plugins/host-metrics. Settings, permissions, services, environment variables and the API reference are made from `manifest.json` and the `@openapi` comments in the code, so keep those up to date instead of writing them by hand. See [writing docs](https://docs.termix.site/develop/docs).
