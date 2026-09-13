# `single-machine-worker-sleep` — single machine, sleeping executor process

| | |
| --- | --- |
| Support level | **Experimental** |
| Implementation status | **Design only. This repository does not implement it: `implemented=false`, `tested=false`, `productionProven=false`** |
| Platforms | Fly.io (1×512 MiB Machine), Docker Compose, systemd — all "once this design is implemented" |
| In one sentence | Two roles on one machine: `publisher` stays resident, `executor` exists as a child process only while there is work and exits when idle. The machine itself never stops. |

Machine-readable definition:
[`presets.single-machine-worker-sleep` in `architecture-matrix.json`](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json).

> **This page is a design contract, not an operating manual.** Before deploying from it, confirm
> that the preset's `status.implemented` in the matrix has become `true`. Today it is still `false`.

---

## Who it is for

- People with only one 512 MiB machine (a Fly Machine or a VPS) that must carry both roles.
- People who want **idle memory usage close to the service role alone** without introducing an
  external clock, a Cloudflare Worker, a second volume or a cross-machine private network.
- People who accept "the machine is billed resident" as a given and want only the memory benefit.
- People who do not mind the `executor` and `publisher` sharing a failure domain.

If the goal is **lowering the compute bill**, this preset cannot help; go to
[`split-worker`](split-worker.md).

---

## Topology

```text
Machine (always on)
│
├─ TelePost supervisor           always-on
│    ├─ publisher                always-on
│    ├─ telegram-ingress         always-on
│    └─ clock(internal)          always-on / tiny
│
├─ PixivFlow child process       no work → no process
│                                work    → spawn
│                                done + grace → exit
│
└─ one volume
     ├─ data/bot{N}/             per-bot SQLite, runtime-policy.json
     └─ data/pixivflow/          pixivflow.db, download cache, outbox
```

The `executor` is not a container but a child process spawned by the resident supervisor. Both bots
share the same resident `publisher`, so adding bots only adds Python child processes on the
`publisher` side, not machines.

`executor` and `publisher` communicate over `loopback-http`, never through a proxy, an overlay or
the public internet.

---

## Resource requirements

| Item | Requirement |
| --- | --- |
| Machine | 1; 512 MiB is the design target; the `256m` profile cannot carry both roles |
| `publisher` | about 170 MiB idle, about 200–230 MiB peak with two bots |
| `executor` | 0 idle (the process does not exist); while running it is bounded by `--max-old-space-size` and `download.concurrency=1` |
| `bots` | `1..2` at 512 MiB; `>=3` needs a larger profile |
| `search` | must be `disabled` |
| `network` | on a 512 MiB machine prefer an **external** proxy; the bundled proxy alone costs 50–100 MiB |

**`executor` and `publisher` competing for memory is the normal case.** The premise of this preset
is that most of the time only one role is eating memory, so download concurrency and image
processing concurrency must be hard-limited rather than left to the operating system's OOM killer.

---

## Lifecycle

| Role | Lifecycle | Who wakes it | Who decides to stop |
| --- | --- | --- | --- |
| `publisher` | `always-on` | not applicable | never stops |
| `telegram-ingress` | `always-on` | not applicable | never stops |
| `clock` | `always-on` | not applicable | not applicable |
| `executor` | `spawn-on-demand` | the supervisor spawns it when a trigger arrives | **the `executor`'s own ledger** (`exitWhenIdle`) |

```text
no work                    trigger
   │                          │
   ▼                          ▼
no process  ────────────────►  spawn executor
   ▲                          │
   │                          │ finished + idle grace
   └──────────────────────────┘  exit(0)
```

### Four invariants that must hold

1. **Process sleep ≠ machine sleep.** The machine never stops; no platform auto-stop, no suspend,
   no mechanism that stops the machine. The only thing that may sleep in this preset is the
   `executor` process.
2. **Saving RAM ≠ saving the bill.** A process exit frees RAM only. The machine is still billed,
   and that must be written into expectations: this is not a substitute for `split-worker`.
3. **The stop decision belongs to the `executor`'s own ledger.** The idle check reads only this
   process's authoritative state: no in-flight slot, no lease-held run, no in-flight download, no
   delivery item being processed or immediately pending. Only when all of these are 0 is it idle,
   and only after `idleGraceMs` of grace does it `exit(0)`. A supervisor timeout, a platform probe
   or an idle connection cannot replace that.
4. **No health check points at the `executor`'s trigger port.** A probe is itself a request; in the
   `wake-run-exit` shape it would wake a machine that just decided it had finished, and in this
   preset it would **respawn the child process that just exited**, producing a loop that never
   settles.

### Why this preset is not "machine-level auto-stop coming back"

A machine-level topology existed historically: a combined autosleep config introduced by
commit `9f3fc53` (and deleted by commit `a98c3a7`),
1×512 combined host, machine-level `auto_stop_machines`, `min_machines_running=0`, waking the whole
machine from Telegram traffic or an external clock. It was deleted for a
structural defect:

> It is deliberate that the trigger side answers as soon as the occurrence is written (a 10–40
> minute run cannot survive a proxy timeout), and the "connection is idle" the proxy sees does not
> mean the task is finished. **The stop decision belongs to the executor's own ledger.**

`single-machine-worker-sleep` is the correct way to reach the same memory goal at the **process**
level: the machine does not move, the `executor` process stops, and the decider is the
`executor`'s own ledger. The difference between the two is not an implementation detail but "who
has the right to judge that the task is over". **Reintroducing machine-level stop reintroduces the
defect.**

---

## Where state lives

| State | Path | Notes |
| --- | --- | --- |
| TelePost per-bot SQLite | `data/bot{N}/` | Submission idempotency keys, review queue, publication records |
| TelePost runtime policy overrides | `data/bot{N}/runtime-policy.json` | Written atomically by the OWNER through `/botconfig` |
| PixivFlow slot ledger | `data/pixivflow/pixivflow.db` | occurrence, slot, slot item |
| Download cache and metadata | relative paths under `data/pixivflow/` | Must be relative paths, see below |
| Delivery outbox | same, files referenced by a manifest | Survives `executor` process restarts |

**One volume, one subdirectory per role.** The statement "the volume is the state boundary" has a
price here: both roles use the same volume, so the `executor` corrupting a directory affects the
`publisher`. Accepting that price is a premise of this preset.

> **Path rule (the lesson of commit `71b4c7c`):** the PixivFlow configuration loader rewrites any
> absolute path that falls outside the directory containing the configuration file back to its own
> default and writes that back into the configuration — and the rewritten value is
> `/app/downloads`, **outside the volume**. So the path of the configuration file **itself** is
> absolute, while the **storage paths inside** the configuration must stay in `./data/...` form.
> This rule holds for every preset, not just this one.

---

## Network

| Item | Value |
| --- | --- |
| `executor` → `publisher` | `loopback-http`, `http://127.0.0.1:8080/api/bot{N}/v1/submissions` |
| Trigger ingress | the `executor` trigger port in the same process (designed value 8090), visible on loopback only |
| `telegram-ingress` | `webhook` (public HTTPS) or `polling` (no ingress) |
| Egress | `direct` or `proxy`; on a 512 MiB machine prefer an external proxy |

Loopback delivery does not go through the proxy and therefore **resets no platform idle timer**.
This is not something the preset depends on (it depends on no platform stop mechanism at all), but
it is a useful fact when debugging "the machine behaves oddly after a delivery".

---

## Strengths

- **Simple deployment.** One machine, one volume, one process arrangement; no external clock, no
  Cloudflare, no private network.
- **Low idle RSS.** While idle only the `publisher` uses memory; the `executor` contributes 0.
- **One volume to back up.**
- **Local same-machine communication.** Delivery does not use a proxy, costs no public traffic and
  is unaffected by overlay failures.
- **No public wake path needed.** Compared with `split-worker` it removes one component (the
  external clock) and one platform dependency.

---

## Weaknesses

- **The Fly Machine is still billed resident.** You save memory, not the bill.
- **`executor` and `publisher` share a failure domain.** A machine-level failure hits both review
  and execution.
- **Memory contention while downloading.** Download concurrency and image processing concurrency
  must be hard-limited, otherwise OOM lands on the `publisher` and what the user sees is a broken
  submission bot.
- **The `executor` holds Telegram credentials** (same machine, same filesystem). Isolation rests
  only on the convention that the supervisor passes Pixiv credentials to the child — it is **not**
  a structural guarantee.
- **`review` and `publish` are unprotected.** The `split-worker` property "an executor crash/OOM
  does not affect Telegram" does not hold here.
- **Not implemented today.** No configuration or code in this repository implements this process
  arrangement.

---

## Failure model

| Failure | Blast radius | Symptom | Recovery |
| --- | --- | --- | --- |
| `executor` OOM while running | Every role on the machine | The child is killed, or the kernel OOM killer spills over into the `publisher` | The supervisor must distinguish a normal `exit(0)` from a signal kill |
| `publisher` crash | All roles | After the machine restarts, the `executor` does not exist | The machine is resident, so restarting restores the resident roles |
| Volume corruption | Both roles lose state together | Review queue and outbox disappear at the same time | Restore from a volume snapshot |
| The supervisor judges idle too early | A truncated batch | A batch that was downloading disappears | **This is the one fatal misconfiguration of this preset**; the idle check must read only the `executor`'s own ledger |
| Egress rate-limited by Pixiv | Only the `executor` | `rate limit cooldown`, escalating penalty | Change egress; see the [incident record (中文)](/incidents/2026-09-11-pixiv-egress-rate-limit.md) |

The failure domain is `single`. The only difference from `single-host` is that this preset adds a
new failure mode — "the supervisor may end the `executor` incorrectly" — and that is precisely the
hardest kind to debug.

---

## Cost model

| Item | Notes |
| --- | --- |
| Machine | Billed resident, whether or not there is work |
| `publisher` | Resident memory, about 170–230 MiB |
| `executor` | Uses memory and CPU only while running; 0 idle |
| Versus `single-host` | Saves memory |
| Versus `split-worker` | You pay the difference between a resident service machine and a resident executor machine, and in exchange you need one less external clock and one less private network |

---

## Deployment steps

**Not executable today.** This is a design contract; the implementation is a later stage, see
Phase 3 of [ROADMAP-MULTI-ARCH.md (中文)](/ROADMAP-MULTI-ARCH.md).

Once implemented, the steps should look like this:

1. Prepare one volume; both `data/bot{N}/` and `data/pixivflow/` live on it.
2. Deploy the resident `publisher` and confirm direct-message submission works and webhook or
   polling is established.
3. Configure the resident supervisor: spawn the `executor` when a trigger arrives, and do not
   restart it after it exits.
4. In the `executor` configuration set `schedulerRuntime.mode`, `exitWhenIdle=true`, `idleGraceMs`
   and `maxLifetimeMs`, and confirm that **no** health check points at the `executor` trigger port.
5. Verify: with no work the `executor` process does not exist; after one trigger the process
   appears; once the ledger is empty the process exits; the machine never stopped throughout.
6. Verify the counter-case: probe the `executor` immediately after a trigger and confirm the probe
   does **not** bring back the exited process.

---

## Migration paths

| Source | Target | State that must move |
| --- | --- | --- |
| `single-host` | this preset | The same `./data` directory; what changes is the process arrangement, not the data |
| `split-worker` | this preset | Merge two volumes into one; fold the executor's download cache and ledger into `data/pixivflow/` |
| this preset | `single-host` | The same directory; drop on-demand spawning and go resident |
| this preset | `split-worker` | Split into two volumes, add an external clock and private-network delivery |

The data inventory and what does and does not need migrating: [migration.md (中文)](/architectures/migration.md).

---

## Terminology quick check

| Statement | Does it hold |
| --- | --- |
| "This machine sleeps" | **Does not hold.** The machine never stops. |
| "The executor process does not exist while idle" | Holds. This is the entire benefit of the preset. |
| "You can save Fly compute cost" | **Does not hold.** The machine is billed resident. |
| "Platform auto-stop can achieve the same effect" | **Does not hold.** That is the deleted defective topology. |
