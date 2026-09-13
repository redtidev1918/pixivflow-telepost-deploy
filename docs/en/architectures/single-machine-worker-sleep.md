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
├─ host-local clock (systemd timer / cron)                  external, no cloud service needed
│
├─ container telepost (upstream TelePost image; this preset does not change it)  always-on
│    ├─ publisher                                                               always-on
│    └─ telegram-ingress                                                        always-on
│
├─ container pixivflow-sleep (this image: docker/worker-sleep.Dockerfile)        always-on
│    └─ supervisor (this repository's supervisor/)                              always-on
│         └─ executor child process                       no work → no process
│                                                         work    → spawn
│                                                         done + grace → exit
│
└─ one physical volume, two disjoint role namespaces (SI-7)
     ├─ data/bot{N}/             per-bot SQLite, runtime-policy.json
     └─ data/pixivflow/          pixivflow.db, download cache, outbox
```

**Two resident containers and one on-demand child process.** Nothing on the machine ever stops; the
`executor` is not a container but a child process spawned by the resident supervisor. The service
side is still an unmodified upstream TelePost image.

**Process orchestration belongs to the deployment layer, not to TelePost.** The thing that spawns
the executor is this repository's `supervisor/` component (Go, stdlib only), not a TelePost feature —
the business repository does not implement deployment orchestration, and the deployment repository
does not implement business logic.

Both bots share the same resident `publisher`, so adding bots only adds Python child processes on the
`publisher` side, not machines.

`executor` and `publisher` communicate over the **platform's own transport** (the container-network
service name on compose, loopback on systemd), never through a proxy, an overlay or the public
internet. The exact addresses are in the Network section below.

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
| `clock` | **external** (host `systemd timer` / `cron`) | not applicable | not applicable |
| `executor` | `spawn-on-demand` | the supervisor spawns it when a trigger arrives | **the `executor`'s own ledger** (`exitWhenIdle`) |

**The clock is a host-local external timer today, not an in-process cron.** The supervisor implements no
cron, so `clock=internal` is still a **design** here and must not be described as implemented until it
is. It also means this preset needs no Cloudflare or any cloud service — a `systemd timer` or `cron`
is enough:

```text
systemd timer / cron
        │  POST http://127.0.0.1:8090/internal/schedules/{id}/run
        ▼
supervisor (resident, owns 8090)
        │  spawns only after authentication, then forwards to 127.0.0.1:8091
        ▼
executor child process (exists on demand)
        │  delivers over the container network: http://telepost:8080/api/bot{N}/v1/submissions
        ▼
publisher (resident)
```

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

**One physical volume, two disjoint role namespaces (SI-7).** TelePost writes `data/bot{N}/`
only; the executor writes `data/pixivflow/` only, and when the supervisor spawns it, only its own
namespace is exposed to the child. Overlapping namespaces are the invalid combination; sharing the
physical volume itself is legal. What remains a single failure domain is the physical volume:
corrupting the whole volume still hits both roles.

> **Path rule (the lesson of commit `71b4c7c`):** the PixivFlow configuration loader rewrites any
> absolute path that falls outside the directory containing the configuration file back to its own
> default and writes that back into the configuration — and the rewritten value is
> `/app/downloads`, **outside the volume**. So the path of the configuration file **itself** is
> absolute, while the **storage paths inside** the configuration must stay in `./data/...` form.
> This rule holds for every preset, not just this one.

---

## Network

**Which transport delivery uses depends on the platform form**; do not state it as unconditionally loopback:

| Item | Compose form (implemented) | systemd form (planned) | Fly form |
| --- | --- | --- | --- |
| `executor` → `publisher` | **container network** `http://telepost:8080/api/bot{N}/v1/submissions` | loopback `http://127.0.0.1:8080` | not implemented |
| Trigger ingress | host `127.0.0.1:8090` → supervisor | same | not implemented |
| supervisor → `executor` child | container loopback `127.0.0.1:8091` (**never published**) | same | not implemented |
| `telegram-ingress` | `webhook` (public HTTPS) or `polling` | same | not implemented |
| Egress | `direct` or `proxy`; prefer an **external** proxy on a 512 MiB machine | same | not implemented |

**Three addresses that must not be conflated:**

```text
host 127.0.0.1:8090        compose publishes only the supervisor's 8090, to host loopback;
                           8091 is never published and exists only inside the worker-sleep container
container telepost:8080    what the executor delivers to: the service name on the container network,
                           not 127.0.0.1
in-container 127.0.0.1:8091  where the supervisor forwards to the child
```

In the compose form delivery is not host loopback: the two roles live in two containers, so the service
name is the only correct address. Loopback delivery applies only to the systemd form, where both roles
are plain processes on one host.
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
- **Host credential isolation does not hold** (matrix field `hostCredentialIsolation=false`; same machine, same filesystem), but the executor
  process **holds no** Telegram credential (SI-1 holds for every preset). Isolation rests on the
  supervisor's **environment allowlist**: when it spawns the executor it passes only Pixiv and
  scheduler credentials (`PIXIV_*`, `SCHEDULER_TRIGGER_TOKEN`, `TELEPOST_BOT*_SUBMIT_TOKEN`) and
  never inherits `BOT*_TOKEN` / `BOT*_CHANNEL_ID` / `BOT*_WEBHOOK_SECRET_TOKEN`. A test guarding
  that allowlist must exist before this preset may be marked implemented.
- **`review` and `publish` are unprotected.** The `split-worker` property "an executor crash/OOM
  does not affect Telegram" does not hold here.
- **Only partly implemented.** The supervisor component (`supervisor/`) is implemented and tested,
  including the environment-allowlist test this page requires; but the preset is **not deployable**:
  there is no image and no platform configuration, and the deployment steps are still a design. The
  matrix therefore keeps it at `implemented=false` / `support=experimental` until the whole path is
  executable.

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

## Implementation status

| Component | Status | Location |
| --- | --- | --- |
| Supervisor binary | **implemented** (Go, stdlib only) | `supervisor/` (main.go / server.go / child.go) |
| Environment allowlist | **implemented and tested** | `supervisor/child.go` + `supervisor/supervisor_test.go` |
| Execution-side container image | **implemented** (built in CI) | `docker/worker-sleep.Dockerfile` |
| Compose form (overlay) | **implemented and validated** | `docker-compose.worker-sleep.yml` |
| Fly / systemd form | missing | — |

### Platform status and the promotion rule (two independent dimensions)

| Platform | Status | Artifacts |
| --- | --- | --- |
| `docker-compose` | **beta** (implemented and CI-validated; end-to-end acceptance not run) | `docker-compose.worker-sleep.yml` + `docker/worker-sleep.Dockerfile` |
| `systemd` | planned | — |
| `flyio` | planned | — |

**A preset's implementation status is not "every platform is done".** The rule is that after at least
one official deployment path completes `documented → implemented → CI-validated → end-to-end
accepted`, the preset may become `implemented=true` with `support=beta`. Today it stops at the
end-to-end step: the compose form is implemented and CI-validated, but two full rounds have not been
run on a real 512 MiB host, so the matrix still says `implemented=false`.

The Fly form is **not** the compose two-container arrangement moved into a new config file: it
requires **one Fly Machine and one image** running TelePost, the resident supervisor and the
on-demand child together. That needs a combined worker-sleep runtime first; otherwise the added
config would be a second Machine and the preset's name would stop being true.
| Deployment steps | still a design | this page |

What the supervisor already does is guarded by tests that spawn real child processes:

- it holds the trigger port resident, with a path and auth contract **identical** to the
  `split-worker` executor (`POST /internal/schedules/{scheduleId}/run` + Bearer), so migrating costs
  the clock nothing;
- only an **authenticated** POST spawns the executor: a probe (GET) gets 404 and a wrong token gets
  401, and neither spawns anything — the "one probe resurrects the child" loop is cut;
- exactly one executor at a time (SI-4); after the child exits it is **not** restarted;
- the supervisor **never** kills the child for being idle: the stop decision belongs to the
  executor's own ledger;
- it distinguishes three outcomes: normal `exit(0)`, killed by a signal (OOM/crash), and a stop the
  supervisor itself requested;
- on shutdown it forwards the signal to the child and leaves no orphan;
- the environment handed to the child is a **deny-by-default allowlist**: only `PIXIV_*`,
  `SCHEDULER_*`, `*_SUBMIT_TOKEN` and generic runtime variables pass; any Telegram credential name
  makes it refuse to start the child.

### The port split belongs to the supervisor

```text
8090  the supervisor's resident public trigger port   <- the clock still POSTs here, same path and auth
8091  the executor child's own trigger port           <- the supervisor forwards to it
```

The supervisor refuses a configuration where both ports are the same, and it **specifies the child's
trigger port for it** (via `SCHEDULER_TRIGGER_PORT`): making an operator align two ports by hand is a
silent mismatch source — the child holds 8090 while the supervisor waits on 8091, which shows up as
"triggers always return 503" while both sides look correct on their own.

The image has **no** `HEALTHCHECK` and explicitly clears any inherited from the base image: a probe
pointing at the executor's trigger port would resurrect the just-exited child. The only thing allowed
to be checked is the supervisor's own `/healthz`, configured by the operator on the platform side and
deliberately not baked into the image.

## Deployment steps

**The compose form is executable; the Fly and systemd forms have no configuration yet.**
The acceptance itself is one command: `./scripts/accept-worker-sleep.sh` (see the
[end-to-end acceptance runbook (中文)](/operations/worker-sleep-acceptance.md)); it returns 0 for PASS,
1 for FAIL and 3 for BLOCKED, and BLOCKED never counts as a pass.

### Compose form (implemented)

```bash
WORKER_SLEEP_IMAGE=<execution-side image> \
docker compose -f docker-compose.yml -f docker-compose.worker-sleep.yml up -d
```

The overlay is **not** a second topology source: the topology is still defined only by
`docker-compose.yml`, and this layer only turns the `pixivflow` service from "resident executor" into
"resident supervisor + on-demand executor" — same service name, same volume, same network, so role
ownership and SI-7 are unchanged. The service side (`telepost`) keeps its own health check untouched.

Why not a profile: in Compose, a service without a profile always starts, and `pixivflow` is exactly
that. Expressing "either a resident executor or an on-demand one" with profiles would make the
default `docker compose up -d` silently start one fewer executor — that breaks the default path
rather than adding a deployment method.

`scripts/validate.sh` renders the merged model to JSON and asserts: the image is the execution-side
one, the **health check is disabled**, the port split is present, and the `telepost` service is
unchanged. Without that health-check assertion, a probe would resurrect the child that just finished
by its own ledger.

### Fly and systemd forms

**Missing.** The Fly form needs this preset's own machine topology, i.e. a third `fly/*.toml`, which
collides with the "exactly two Fly configs" contract — that needs a decision, see Phase 3 of
[ROADMAP-MULTI-ARCH.md (中文)](/ROADMAP-MULTI-ARCH.md).

### The full compose steps

1. Prepare one volume; both `data/bot{N}/` and `data/pixivflow/` live on it, mounted into both
   containers.
2. Deploy the resident `publisher` (unmodified upstream TelePost image) and confirm direct-message
   submission works and webhook or polling is established.
3. Configure the resident supervisor (`SUPERVISOR_CHILD_CMD` / `SCHEDULER_TRIGGER_TOKEN` /
   `SUPERVISOR_LISTEN` / `SUPERVISOR_CHILD_TRIGGER`): spawn the `executor` when a trigger arrives, and do not
   restart it after it exits. `SUPERVISOR_CHILD_CMD` must be a **single command** (the supervisor
   runs `sh -c "exec <cmd>"`; leaving a wrapper shell around would distort signals and exit
   status); use a wrapper script if you need pipes or multiple steps.
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
