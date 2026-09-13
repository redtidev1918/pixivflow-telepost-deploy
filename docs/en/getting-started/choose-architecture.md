# Which deployment should I choose?

> **This page answers one question: which preset should you use.** The 15-second table is below,
> the 30-second decision tree is below that. Technical detail per preset lives in
> [architectures/](../architectures/overview.md); this page only chooses.

---

## Start from your situation

| Your situation | Recommended preset | Why |
| --- | --- | --- |
| I only have one VPS / NAS / home machine | [`single-host`](../architectures/single-host.md) | Fewest components, one command to run, no external clock needed |
| I only have one 512 MiB Fly Machine | [`single-machine-worker-sleep`](../architectures/single-machine-worker-sleep.md) | One machine holds both roles, and the executor process does not exist while idle. **Currently design only, not implemented** |
| I want the lowest Fly bill | [`split-worker`](../architectures/split-worker.md) | The executor is normally `stopped`; no task means no compute charge |
| I care most about reliability | [`split-worker`](../architectures/split-worker.md) | An executor crash or OOM does not propagate into the user-visible submission path |
| I have a VPS + a home server | [`remote-worker`](../architectures/remote-worker.md) | Each role on its own machine, communicating over a private network or public HTTPS |
| I care most about Pixiv egress quality | [`remote-worker`](../architectures/remote-worker.md) | The executor can live alone on a machine whose egress is already qualified |
| I just want it running as fast as possible | [`single-host`](../architectures/single-host.md) | No Fly, no Cloudflare, no domain |
| I do not want the executor to touch Telegram credentials | [`split-worker`](../architectures/split-worker.md) or [`remote-worker`](../architectures/remote-worker.md) | Only these two presets have a credential boundary that holds |

---

## Decision tree

```text
Only one machine?
├─ Yes
│  ├─ Memory ≥ 1 GiB ─────────────────► single-host
│  ├─ Memory = 512 MiB
│  │  ├─ Save RAM, accept resident billing ──► single-machine-worker-sleep (not implemented today)
│  │  └─ Save the bill ───────────────► split-worker (host the executor on Fly)
│  └─ Memory = 256 MiB ───────────────► single-host, publisher only (executor elsewhere)
└─ No
   ├─ Using Fly.io ────────────────────► split-worker
   ├─ Already multi-node (VPS + home machine, ...) ──► remote-worker
   └─ Just want the executor elsewhere ──────────► remote-worker
```

**The same five questions, as follow-ups.** When the answer is not obvious, ask in this order:

1. How many machines can you keep powered on long term? 1 → co-located; 2 or more → separated.
2. Can the executor stop? It can → `split-worker` (saves the bill) or
   `single-machine-worker-sleep` (saves RAM).
3. Are you willing to maintain an external clock (a Cloudflare Worker, or any HTTP cron)?
   Not willing → use `clock=internal`, which means the resident form of `single-host` or
   `remote-worker`.
4. Do you have a public HTTPS ingress? No → `telegramIngress=polling`, no domain or certificate
   needed.
5. Is your Pixiv egress qualified on this machine? No → move the executor to another machine, see
   the [incident record (中文)](/incidents/2026-09-11-pixiv-egress-rate-limit.md).

---

## What you do not have to decide up front

| Worry | Fact |
| --- | --- |
| "If I choose wrong I have to start over" | All four presets share the same business semantics and the same state format, so migration is moving state. See [migration.md (中文)](/architectures/migration.md) |
| "The resource profile must be chosen with the architecture" | No. Architecture and resource profile are two independent dimensions and combine freely |
| "Is 512 MiB limited to a single bot?" | No. The `256m` profile is single-bot, the `512m` profile is two bots — see [performance.md (中文)](/operations/performance.md) |
| "Is this unusable on a mainland-China network?" | Compose and systemd both support `network=proxy`, see [proxy.md](../platforms/proxy.md) |
| "I have to learn a pile of Fly concepts" | Only `split-worker` needs that. `single-host` needs Docker only |

---

## Next step after choosing

| You chose | Do this now |
| --- | --- |
| `single-host` | [quickstart.md](quickstart.md) → [docker.md](../platforms/docker.md) |
| `split-worker` | [split-worker.md](../architectures/split-worker.md) → [flyio.md](../platforms/flyio.md) → [cloudflare.md](../platforms/cloudflare.md) |
| `remote-worker` | [remote-worker.md](../architectures/remote-worker.md) → [vps.md](../platforms/vps.md) |
| `single-machine-worker-sleep` | Read [this preset's status fields](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json) first: **there is no implementation yet** |

---

## One trade-off that is constantly confused

```text
process sleep  ≠  machine sleep
saving RAM     ≠  saving the compute bill
```

- `single-machine-worker-sleep` makes the **executor process** disappear → saves RAM, the machine
  is still billed.
- `split-worker` puts the **executor machine** into `stopped` → saves the compute bill.

The two are not interchangeable. If you read "sleeping the executor saves money", it refers to the
latter, not the former. Details in [lifecycle.md (中文)](/concepts/lifecycle.md).
