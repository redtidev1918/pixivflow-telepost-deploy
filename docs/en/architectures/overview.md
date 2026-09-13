# Deployment architecture overview (preset matrix)

**This file is the architecture index for humans. The machine-readable one is
[`docs/reference/architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json);
`architecture_docs_test.go` forces the two to agree.**

One premise: **there is exactly one core business model, and there can be several legal
implementations of the deployment topology.**

```text
logical architecture (fixed)   deployment topology (optional)   resource profile (optional)   platform (optional)
who owns which decision    ×   where roles run, who        ×   how much memory each      ×   who executes
                               may sleep, who wakes           running unit gets              this topology
```

The four dimensions are independent. `docs/concepts/roles.md` defines the first,
this file and the four preset pages define the second,
`docs/operations/performance.md` and `docs/reference/environment.md` define the third, and
`docs/platforms/` defines the fourth.

---

## Supported presets

| Preset | Support level | Implementation status | In one sentence | Docs |
| --- | --- | --- | --- | --- |
| `single-host` | Stable | implemented, CI-covered, not production-proven | One machine runs every role, two containers sharing one data directory | [single-host.md](single-host.md) |
| `single-machine-worker-sleep` | Experimental | **components implemented, preset not deployable** | One machine: the service stays resident, the executor is spawned on demand and exits when idle | [single-machine-worker-sleep.md](single-machine-worker-sleep.md) |
| `split-worker` | Stable | implemented, tested, **current production** | Executor and service each on their own machine and their own volume | [split-worker.md](split-worker.md) |
| `remote-worker` | Beta | implemented, not end-to-end tested | The two roles communicate across machines and networks | [remote-worker.md](remote-worker.md) |

Support level and implementation status are two different things; never merge them into one word:

| Support level | Meaning |
| --- | --- |
| `stable` | Contract frozen; its behaviour may be relied on. The matrix enforces that `stable` must be `implemented` and `tested`. |
| `beta` | Implemented, interface may still change, end-to-end evidence missing. |
| `experimental` | The design exists; the implementation may not. Read the matrix `status` first. |
| `deprecated` | Explanation and migration path kept, no more fixes. No preset is at this level today. |

| Status field | Meaning |
| --- | --- |
| `documented` | Executable documentation exists, with no undefined behaviour. |
| `implemented` | Real configuration or code paths exist in this repository. |
| `tested` | CI or a script verifies it, and that verification **can fail**. |
| `productionProven` | Real production traffic has run through it. |

---

## Where the roles run

Role ids match `docs/concepts/roles.md`: `clock`, `executor`, `publisher`, `telegram-ingress`,
`state`, `network`.

| Preset | `clock` | `executor` | `publisher` | `telegram-ingress` | State layout | Executor holds Telegram credentials (SI-1) | Host credential isolation |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `single-host` | in-machine `internal` | same-host container, resident | same-host container, resident | same host, webhook or polling | shared volume, disjoint role subdirectories | **No** | **No** |
| `single-machine-worker-sleep` | in-machine `internal` | same-host child process, on demand | same host, resident | same host, webhook or polling | shared volume, disjoint role subdirectories | **No** | **No** |
| `split-worker` | Cloudflare (`cloudflare`) | own machine, `wake-run-exit` | own machine, resident | on the service machine, webhook or polling | two volumes, one per machine | **No** | **Yes** |
| `remote-worker` | `internal` / `cloudflare` / `external` | own host, `wake-run-exit` or resident | own host, resident | on the service host, webhook or polling | one volume per host | **No** | **Yes** |

**Co-location is a physical fact, not a semantic merge.** Even when `single-host` puts both roles
on one machine, the `executor` does not thereby gain review or publish rights, and the `publisher`
does not thereby gain Pixiv login or slot scheduling rights.
See [roles.md (中文)](/concepts/roles.md).

---

## Feature switches

The architecture preset decides the skeleton; feature switches decide the details. A switch cannot
change role ownership.

| Switch | Values | Default | Notes |
| --- | --- | --- | --- |
| `clock` | `internal` \| `cloudflare` \| `external` | `internal` | Who decides "when to run" |
| `telegramIngress` | `webhook` \| `polling` | `polling` | Who decides how Telegram arrives |
| `network` | `direct` \| `proxy` | `direct` | Whether egress goes through a proxy |
| `bots` | `1..N` | `2` | One supervised process per bot |
| `search` | `enabled` \| `disabled` | `disabled` | Search index and tokeniser dictionary |
| `review` | `enabled` (fixed) | `enabled` | Human review is a product contract, not a switch |

`review` has exactly one legal value. `review.enabled=false` is an **invalid combination**, not an
option — see the next section.

---

## Legal combinations

Not every combination holds. This repository recognises only the combinations listed in the
matrix, so you do not have to guess.

### SUPPORTED

| Condition | Why it holds |
| --- | --- |
| `clock=internal` and the executor is resident or on demand | The process that owns the clock is resident, so a cron tick always finds a live executor |
| `clock=cloudflare\|external` and the executor is `wake-run-exit` | The trigger request is what starts the machine, and stopping is decided by the executor's own ledger |
| A separate proxy unit is used | The proxy has its own memory budget and does not compete with other roles |

### SUPPORTED_WITH_LIMITATIONS

| Condition | Limitation |
| --- | --- |
| `telegramIngress=webhook` but no public HTTPS ingress | Needs a tunnel or reverse proxy; otherwise use polling |
| `bots>=3` and any unit budget of 512 MiB | One process per bot, memory grows linearly; without a larger profile you get OOM |
| `single-host` / `single-machine-worker-sleep` | Host credential isolation is absent (shared host environment); the executor unit still receives no Telegram credential (SI-1 holds for every preset) |
### EXPERIMENTAL

| Condition | Notes |
| --- | --- |
| Any combination of `single-machine-worker-sleep` | The orchestration is implemented but the preset is not deployable: no image and no platform config |

### INVALID

| Condition | Why it is invalid |
| --- | --- |
| Executor `wake-run-exit` + `clock=internal` | A stopped process cannot fire its own cron; nothing would ever wake it |
| `review.enabled=false` | Publishing without human approval is outside the product contract |
| Two roles write the same state namespace (even on one shared physical volume) | A shared physical volume with disjoint role-owned subdirectories is legal; overlapping namespaces are invalid (SI-7) |
| `search=enabled` and the same unit also runs the executor with a 512 MiB budget | The tokeniser dictionary plus the downloader exceed the budget |
| Bundled proxy + the `256m` profile | The proxy alone costs 50–100 MiB |
| Two clocks firing the same schedule set | Duplicate triggering is idempotent; credential contention is not |
| Under `split-worker`, the executor holds any Telegram token or channel ID | It would become a webhook owner candidate and could publish outside review |

---

## Platform support

| Platform | Supported presets | Docs |
| --- | --- | --- |
| Docker Compose | `single-host`, `single-machine-worker-sleep`, `remote-worker` | [docker.md](../platforms/docker.md) |
| Fly.io | `single-machine-worker-sleep`, `split-worker`, `remote-worker` | [flyio.md](../platforms/flyio.md) |
| systemd (bare-metal Linux) | `single-host`, `single-machine-worker-sleep`, `remote-worker` | [vps.md](../platforms/vps.md) |
| Cloudflare Workers | the clock plane of `split-worker` and `remote-worker` | [cloudflare.md](../platforms/cloudflare.md) |

The `split-worker` reference implementation is Fly.io, but the "split executor" topology itself is
not bound to a platform: the platform support table lists **configuration this repository has
already written**, not the ceiling of what the topology can do.

---

## Two cost-saving dimensions that are not the same

```text
process sleep ≠ machine sleep
saving RAM    ≠ saving the compute bill
```

These two lines are what make `single-machine-worker-sleep` a completely different thing from the
deleted machine-level auto-stop topology. An `executor` process exit frees memory only; the machine
is still billed. To bring the compute bill down, the **machine** has to reach `stopped` — that is
`split-worker`, and it must be woken by an external clock and stopped by the executor's own ledger.
See [lifecycle.md (中文)](/concepts/lifecycle.md).

---

## Migration

The four presets can migrate into each other; the data requirements are in
[migration.md (中文)](/architectures/migration.md).
All presets share the same business semantics and the same state format, so migration is moving
state, not changing the business.
