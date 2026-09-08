# Cloudflare Cron Worker — generic schedule clock (reference adapter)

A **dumb external clock** for PixivFlow in `schedulerRuntime.mode: "external"`
(scale-to-zero / autosleep hosts like a stopped Fly machine).

It holds no business state and never talks to Pixiv: on each cron fire it looks up
the **PixivFlow schedule id** bound to that cron (a data-driven map) and POSTs to
that schedule's authenticated trigger URL. The woken PixivFlow process resolves the
canonical occurrence itself from its OWN cron + timezone, so this worker needs no
knowledge of slots, dates, or "morning/evening" — and duplicate/retry fires are
idempotent (they converge on one durable occurrence).

The clock is **provider-decoupled**: anything that can send an authenticated POST
(cron-job.org, EasyCron, GitHub Actions, a VPS cron + curl) can replace this worker
with **no PixivFlow Core change**.

## Configuration

Set via `wrangler secret` / dashboard (secrets) and `[vars] SCHEDULES` (non-secret):

| Var / Secret | Example | Purpose |
|---|---|---|
| `SCHEDULE_TRIGGER_URL` (secret) | `https://<your-fly-app>.fly.dev` | Base URL; the worker appends `/internal/schedules/<id>/run` |
| `SCHEDULE_TRIGGER_TOKEN` (secret) | a strong random token | Bearer token; must equal PixivFlow's `SCHEDULER_TRIGGER_TOKEN` |
| `SCHEDULES` (var/secret, JSON) | `{"0 2 * * *":"morning","0 10 * * *":"evening"}` | Maps each firing cron (must match `[triggers] crons` exactly) to a PixivFlow **schedule id** |

The schedule ids on the right are YOUR ids (see PixivFlow config `schedules[].id`).
Use any number/times of schedule and any cron granularity — there is no hardcoded
schedule in the worker. Example for a different deployment:

```json
{ "0 2 * * *": "daily-ranking", "0 10 * * *": "evening-digest", "0 */6 * * *": "artist-watch" }
```

## Deploy

```bash
npm i
npx wrangler secret put SCHEDULE_TRIGGER_URL     # https://<your-fly-app>.fly.dev
npx wrangler secret put SCHEDULE_TRIGGER_TOKEN   # == PixivFlow SCHEDULER_TRIGGER_TOKEN
# edit wrangler.toml: [triggers] crons + [vars] SCHEDULES to match your schedule ids
npx wrangler deploy
```

## Manual smoke test / ops trigger (idempotent, safe to repeat)

```bash
# Trigger schedule id "morning" directly through the worker:
curl -i -X POST -H "Authorization: Bearer $SCHEDULE_TRIGGER_TOKEN" \
  "https://<worker>.workers.dev/__trigger/morning"

# Optional human provenance label (shown in the review card; never parsed):
curl -i -X POST -H "Authorization: Bearer $SCHEDULE_TRIGGER_TOKEN" \
  "https://<worker>.workers.dev/__trigger/morning?label=%E4%BB%8A%E6%97%A5%E6%97%A9%E7%8F%AD"
```

Or hit PixivFlow's trigger endpoint directly (same contract the worker uses):

```bash
curl -i -X POST "https://<your-fly-app>.fly.dev/internal/schedules/morning/run" \
  -H "Authorization: Bearer $SCHEDULER_TRIGGER_TOKEN" \
  -H "Content-Type: application/json" -d '{}'
```

Outside the schedule's grace window the API answers `425 not due yet` /
`410 expired` without running anything — the public endpoint cannot back-fill
history. Unknown schedule ids answer `404`; bad/missing token answers `401`;
no token configured answers `503` (fail closed).

## Notes

- The request stays open for the whole run (it IS the activity lease that keeps the
  autosleep machine awake). The worker allows up to 8 minutes; a timeout just means
  the next fire / watchdog safely resumes the same occurrence.
- The optional GitHub watchdog (`../github/slot-watchdog.yml`) re-POSTs the same
  idempotent trigger ~10 minutes later as a backup. It is not required for
  correctness.
