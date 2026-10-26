# Home Monitor API Worker

Cloudflare Worker for the Home Monitor API. The API, bot, and dashboard share the D1 database configured in `wrangler.jsonc`.

## Home Monitor v5

`migrations/0001_home_monitor_v5.sql` adds the v5 runtime state for scheduler deduplication, recommendation lifecycle and feedback, event grouping, climate anomalies, AI Caretaker traces, and nightly Sleep Score. It inserts v5 thresholds using `ON CONFLICT DO NOTHING`, preserving values already configured by the owner. It removes the retired notification category settings `rain_window`, `home_score`, and `ventilation`; export or back up D1 first if those rows need to be restored for rollback.

The migration creates the settings and notification configuration tables when missing, so it is safe to apply before the Workers' first request on a fresh D1. The rest of the API's sensor, telemetry, and recommendation core schema remains managed by the existing Home Monitor API/bootstrap. The migration is idempotent and tested against both empty D1 and representative legacy v4 settings.

### Preview deployment

From this directory, run tests and apply only to local D1:

```sh
npm test
npx wrangler d1 migrations apply DB --local --directory ./migrations
npx wrangler deploy --dry-run
```

Review the preview database before release. Back up the shared production D1, then apply the migration once and deploy API before the bot:

```sh
npx wrangler d1 migrations apply DB --remote --directory ./migrations
npx wrangler deploy
```

The commands above are documentation only; no production migration or deployment was run for this change. Deploy the bot after the API because its recommendation queries read the new lifecycle table.

### Rollback

Redeploy the prior API and bot Worker versions. Leave the new tables in D1; the old code can ignore them. Restore deleted notification category/settings rows from the pre-migration D1 backup if the old release needs them. Do not use destructive `DROP TABLE` rollback SQL against the shared database.

## v5 settings

The migration seeds safe defaults for climate anomaly thresholds, condensation margin, tariff forecast notification thresholds, sleep window, event grouping, and climate sample interval. Admin settings remain available at `/api/v1/admin/settings`. No new secrets or bindings are required. The bot continues to use the existing `DB` D1 and `AI` Workers AI bindings.

Run `npm test` for the engine and migration tests. The tests use Node's built-in test runner and an in-memory SQLite database; they do not contact Cloudflare or Telegram.
