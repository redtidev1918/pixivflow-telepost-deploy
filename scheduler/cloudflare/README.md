# External Slot clock — Cloudflare Worker

A **dumb external clock** for the Fly-autosleep PixivFlow+TelePost deployment.
It holds no business state and never talks to Pixiv: on a cron schedule it POSTs
the slot name to PixivFlow's authenticated Slot API, which wakes the stopped Fly
machine and runs the batch synchronously. See [../../docs/SCHEDULING.md](../../docs/SCHEDULING.md)
for the model and invariants.

## Why a Worker

- Free-tier Workers can run cron triggers; no server to keep alive.
- The clock is provider-decoupled: anything that can send an authenticated POST
  works (this Worker, GitHub Actions, cron-job.org, your own VPS cron).
- Duplicate fires are idempotent on the PixivFlow side (Slot ledger), so adding
  the optional GitHub watchdog in `../github/` is safe.

## Deploy

Prereq: a Cloudflare account + `npx wrangler login` (or `CLOUDFLARE_API_TOKEN`).

```bash
cd scheduler/cloudflare
npm install            # only fetches wrangler/types; the Worker has no runtime deps

# Set the two secrets (values come from YOUR deployment):
npx wrangler secret put SCHEDULE_TRIGGER_URL
#   -> https://<your-fly-app>.fly.dev/internal/schedules/run
npx wrangler secret put SCHEDULE_TRIGGER_TOKEN
#   -> the same value as the Fly secret SCHEDULER_TRIGGER_TOKEN

npx wrangler deploy
```

The Worker deploys with two cron triggers (UTC):

| Cron (UTC) | Beijing time | Slot |
|---|---|---|
| `0 2 * * *` | 10:00 | morning |
| `0 10 * * *` | 18:00 | evening |

## Smoke test (idempotent, safe)

Outside a slot window the API answers `425 not due yet` / `410 expired` without
doing any work — a cheap way to prove auth + routing end to end:

```bash
curl -i -X POST "https://<your-fly-app>.fly.dev/internal/schedules/run" \
  -H "Authorization: Bearer $SCHEDULER_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" -d '{"slot":"evening"}'
```

To exercise the Worker itself (also gated by the same window):

```bash
curl -i "https://<worker>.workers.dev/__sched?slot=morning" \
  -H "Authorization: Bearer $SCHEDULER_TRIGGER_TOKEN"
```

## Notes

- The request stays open for the whole slot run (activity lease keeps the Fly
  machine awake); the Worker allows up to 8 minutes and treats failure as
  retryable.
- No secrets live in `wrangler.toml`; only via `wrangler secret put`.
