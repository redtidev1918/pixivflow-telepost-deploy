# Deployment contract (unified deployment model)

> **This page is the single authoritative description of which concepts make up a deployment and
> where each concept's authority lives.** It collapses the deployment logic scattered across
> `docker-compose.yml`, `fly/*.toml`, `control-plane/`, `deploy.go`, the README and the docs into
> **one conceptual model**. Phase one does not make the program read it; it unifies the
> documentation model, the directory naming and the agent contract. The machine-readable instance
> is [architecture-matrix.json](https://github.com/redtidev1918/pixivflow-telepost-deploy/blob/main/docs/reference/architecture-matrix.json).

## Why it exists

The same thing used to be stated in three places: the README said one topology, `fly.toml` said
another, `docker-compose.yml` said a third. The goal of the contract is that every concept has
**exactly one authoritative source**, and that "which deployment is this" can be read out of one
manifest instead of guessed from a dozen documents.

## The eight concepts

| Concept | Question it answers | Authoritative source |
| --- | --- | --- |
| `DeploymentPreset` | Where each role runs, and which of them may sleep | [architectures/overview.md](../architectures/overview.md) + matrix `presets` |
| `RuntimeRole` | Who owns which decision | [roles.md (中文)](/concepts/roles.md) + matrix `roles` |
| `LifecyclePolicy` | Who may sleep, who wakes it, who decides to stop | [lifecycle.md (中文)](/concepts/lifecycle.md) + matrix `enums.lifecycle` |
| `StateOwnership` | Which volume holds each role's state | [state.md (中文)](/concepts/state.md) + matrix `enums.stateLayout` |
| `TriggerProvider` | Who decides "when it runs" | [scheduling.md (中文)](/concepts/scheduling.md) + matrix `enums.clockProvider` |
| `NetworkTransport` | Which transport runs between roles, and whether egress goes through a proxy | [network.md (中文)](/concepts/network.md) + matrix `enums.transport` |
| `CredentialBoundary` | Who holds which credential, and in which presets the boundary holds | [credentials.md (中文)](/concepts/credentials.md) + matrix `securityInvariants` |
| `ResourceProfile` | How much memory each running unit gets | [environment.md (中文)](/reference/environment.md) + matrix `resourceProfiles` |

These four dimensions are independent of one another — that is the foundation of the whole design:

```text
Logical architecture (fixed)   Deployment topology (optional)   Resource profile (optional)   Platform (optional)
which role owns which      ×   where roles run, who may      ×   how much memory each      ×   who executes this
decision                       sleep, who wakes them            running unit gets             topology
```

The matrix records this explicitly in `dimensions[]`: `logical-architecture` has
`variesByDeployment` = `false`, the other three are `true`. **Any claim that the business semantics
changed because the deployment method changed conflicts with this contract.**

## Manifest shape

A preset's deployment manifest looks like this (example: current production `split-worker`). It is
a **documentation model**, not runtime input; the concrete values come from the matrix.

```yaml
preset: split-worker

roles:
  publisher:                     # logical role (never changes)
    placement: fly               # deployment fact (may change)
    lifecycle: always-on
    owns_state: [
      "/app/data/botN/",         # per-bot SQLite + runtime-policy.json
    ]
    credentials: [BOT*_TOKEN, BOT*_CHANNEL_ID, BOT*_OWNER_ID]
    telegram_credentials: true

  executor:
    placement: fly
    lifecycle: wake-run-exit
    owns_state: ["/app/data"]    # slot ledger + download cache + outbox
    credentials: [PIXIV_*, TELEPOST_BOT*_SUBMIT_TOKEN, SCHEDULER_TRIGGER_TOKEN]
    telegram_credentials: false  # SI-1

clock:
  provider: cloudflare           # cloudflare | external | internal
  placement: edge-serverless

transport:
  executor_to_publisher: flycast # loopback-http | container-network | flycast | private-overlay | public-https

network:
  mode: direct                   # direct | proxy

state:
  layout: own-volume             # own-volume | own-volume-subdirectory | shared-volume | none
  volumes:
    - { owner: executor, mount: "/app/data" }
    - { owner: publisher, mount: "/app/data" }

resource_profile: 512m           # see enums / resourceProfiles
```

**The legal values of every field** are all defined in the matrix `enums` (`supportLevel`,
`roleKind`, `lifecycle`, `clockProvider`, `telegramIngress`, `networkMode`, `transport`,
`stateLayout`, `searchMode`, `combinationVerdict`). Adding a value means changing the matrix,
`architectures/overview.md` and this page together, and `architecture_docs_test.go` checks that
they agree.

## Presets and feature switches

Deployment choice is deliberately designed as **a small number of proven presets + a limited set
of feature switches**, not arbitrary permutations — the latter would cause a combinatorial
explosion (see "legal combinations" in [overview.md](../architectures/overview.md)).

| Dimension | Values | Default |
| --- | --- | --- |
| preset | `single-host` \| `single-machine-worker-sleep` \| `split-worker` \| `remote-worker` | chosen by the user |
| `clock` | `internal` \| `cloudflare` \| `external` | `internal` |
| `telegramIngress` | `webhook` \| `polling` | `polling` |
| `network` | `direct` \| `proxy` | `direct` |
| `bots` | `1..N` | `2` |
| `search` | `enabled` \| `disabled` | `disabled` |
| `review` | `enabled` (fixed) | `enabled` |

Whether a combination holds is answered by the matrix `combinationRules`, in four grades:
`supported`, `supported-with-limitations`, `experimental`, `invalid`. **The user does not have to
guess.**

## Single source of truth

| Concept | Sole authority | Where it may not be declared again |
| --- | --- | --- |
| Architecture preset definitions | `architecture-matrix.json` + `architectures/*.md` | the README, `fly/*.toml` comments, compose comments |
| Preset matrix (support level) | `architecture-matrix.json` `presets.*.status` | any second statement of "the only production topology" |
| Fly topology | `fly/deploy.pixivflow.toml` + `fly/deploy.telepost.toml` (these two, no more) | a third `*.toml` |
| Compose topology | `docker-compose.yml` | a second compose variant |
| Scheduling contract | [scheduling.md (中文)](/concepts/scheduling.md) | prose restatements |
| Credential contract | [credentials.md (中文)](/concepts/credentials.md) | any script that prints credentials |
| Deployment contract (this page) | this file | "another version" in the README |

**Two files must never both declare "the only production topology".** The production topology is
`split-worker` (`Recommended Fly.io production topology`), but it is the *current* production, not
the *only legal* architecture. That sentence itself is the drift `docs-validation` exists to
prevent.

## How agents and tests consume it

- `architecture_docs_test.go` checks: the preset names in the matrix are consistent across
  `overview.md`, `AGENTS.md` and each preset document; every preset marked `stable` has a document;
  config files referenced by the docs exist; enum values are legal; there is no second "only
  production topology" statement; the `split-worker` security contract is intact.
- The agent reading order is: `AGENTS.md` → this page → the matrix → the specific preset document.

## Relationship to the previous state

This contract introduces no breaking change. The live `split-worker` configuration, the two Fly
configs, `control-plane/`, the four read-only scripts and the existing guard tests all keep
working; this page only gives them one shared name and one source.

## Related pages

- Preset index: [architectures/overview.md](../architectures/overview.md)
- Role contract: [roles.md (中文)](/concepts/roles.md)
- Environment variables and resource profiles: [environment.md (中文)](/reference/environment.md)
- Platforms: [platforms/docker.md](../platforms/docker.md), [platforms/flyio.md](../platforms/flyio.md), [platforms/vps.md](../platforms/vps.md), [platforms/cloudflare.md](../platforms/cloudflare.md)
- Migration contract: [migration.md (中文)](/architectures/migration.md)
