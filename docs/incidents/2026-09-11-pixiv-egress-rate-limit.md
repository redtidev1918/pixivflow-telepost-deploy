# Incident 2026-09-11 — Pixiv egress rate-limit starvation on GitHub-hosted runners

## Context

`pixivflow-telepost-deploy` moved the Pixiv execution plane from the legacy Fly daemon
(`telesubmit-multi-bot`) to GitHub-hosted runners. The Cloudflare Worker + D1 control
plane was already live: scheduling, reconciliation, credential admission, review state
and the Telegram webhook all run there.

## Symptom

- Historically, the same Pixiv workload completed within a few minutes on Fly.
- On GitHub-hosted runners, PixivFlow can authenticate and resolve topics, but a
  production-like workload repeatedly enters `Pixiv rate limit cooldown`, climbs through
  `penaltyLevel` 1 → 2, and never produces a review before the batch's own 1800000 ms
  watchdog cancels it.

## Evidence

Real GitHub Actions run `34558034050` (`pixivflow-batch`, `main`, 2026-09-11 03:20Z,
conclusion `failure`). Key timeline, abbreviated (not a full log dump):

```text
03:20:44  PixivFlow runtime starting
03:20:45  refresh Pixiv access token success
03:21:10  TopicResolver refresh: resolvedTags=12, sampled=100
03:23:26  rate limit cooldown  penaltyLevel=1
03:26:12  rate limit cooldown  penaltyLevel=1
03:27:18  rate limit cooldown  penaltyLevel=2
03:31:25  rate limit cooldown  penaltyLevel=1
03:32:28  rate limit cooldown  penaltyLevel=2
03:37:40  rate limit cooldown  penaltyLevel=1
03:41:21  rate limit cooldown  penaltyLevel=1
03:44:04  rate limit cooldown  penaltyLevel=1
03:45:05  rate limit cooldown  penaltyLevel=2
03:50:44  batch watchdog 1800000 ms -> download cancelled
```

## Interpretation

**This proves reachability but not suitability.** GitHub-hosted runners can reach Pixiv
OAuth and the App API; the same endpoints under production-like load suffer severe
rate-limit starvation on this egress.

| level | statement |
| --- | --- |
| confirmed | GitHub-hosted runners reach Pixiv OAuth / App API; production-like workloads repeatedly hit sustained 429 / penalty escalation and die on the 30-minute watchdog |
| high confidence | the shared-datacenter egress / IP reputation of GitHub-hosted runners is subject to stricter Pixiv rate-limiting; the gap vs. the historical few-minute Fly baseline supports this |
| unconfirmed | Pixiv does **not** blanket-block GitHub IPs, Cloudflare Workers, or `i.pximg.net`; Fly is **not** permanently guaranteed; an ordinary VPS is **not** guaranteed to be unthrottled — each needs its own egress A/B probe |

## Unknowns

- Whether the throttle is ASN / IP-reputation based — unknown.
- Whether the Cloudflare Worker data plane would behave the same — unknown.
- Whether `i.pximg.net` media download is throttled on GitHub egress — unknown.
- Whether a VPS / self-hosted runner is stable — needs an A/B probe.

## Architectural consequence

**Control-plane compatibility does not imply execution-plane compatibility.**

PixivFlow depends on several distinct Pixiv data planes, each of which must be qualified
separately:

| plane | endpoint |
| --- | --- |
| OAuth | `oauth.secure.pixiv.net` |
| App API | `app-api.pixiv.net` |
| media CDN | `i.pximg.net` (requests carry `Referer: https://app-api.pixiv.net/`) |

The durable control plane (Cloudflare Worker + D1) stays where it is. The execution
provider becomes a replaceable, egress-qualified data plane. GitHub-hosted runners remain
implemented and are still suitable for CI, shadow, and non-heavy tests, but are currently
**not production-qualified for the Pixiv data plane**.

The credential admission invariant is unchanged regardless of provider: `pixiv-main` keeps
at most one active production execution, decided by D1 — a provider is an execution
resource, never a second scheduler.

## Follow-up

TODO: a single `pixivflow diagnose egress` probe (OAuth / App API / media / controlled
burst) to A/B GitHub / Cloudflare / Fly / VPS / self-hosted runners against the same
credential, request shape, User-Agent and Referer — modelled on DeviantDrop's
`scripts/detect-da.mjs`, which already draws the same line for a different platform:
Telegram/control logic is not the same thing as third-party data-plane egress.
