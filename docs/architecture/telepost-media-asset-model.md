# RFC: TelePost MediaAsset / DeliveryVariant Domain Model (Batch 5)

Status: IMPLEMENTED — TelePost 2.58.0 (PR #223, 2026-09-21)
Scope: TelePost only (PixivFlow domain model already landed: `MediaAsset`,
`Artifact`, `ResolvedWork`, `MaterializationPolicy`)
Authority: `pixivflow-telepost-deploy` (media-decoupling-delivery-plan.md Phase 5)

## 1. Problem

TelePost persists canonical media refs (`media_asset_refs`) and plans their
Telegram delivery (`DeliveryPlanner`), but the domain facts are raw dicts:

- `telepost/storage/sqlite/media_assets.py` returns `List[Dict]`;
- `_validate_media_assets` in `utils/api_server.py` re-implements shape checks;
- `MediaPlanEntry` carries `asset_id`/`source_url` as plain strings;
- "which Telegram source wins" (file_id / remote_url / local) is an implicit
  planner strategy, not a typed value.

Consequence: every consumer re-names the same fields, and a future delivery
variant (e.g. copyMessages, multipart upload) has no home.

## 2. Current state (as-is, verified 2026-09-21)

```text
telepost/domain/delivery.py        MediaKind / TelegramFileId / LocalFile /
                                   RemoteUrl / MediaSource / MediaItem
telepost/application/delivery_planner.py  MediaPlanEntry + MediaDeliveryPlan
                                          (strategy: file_id|remote_url|mixed|empty)
telepost/storage/sqlite/media_assets.py  media_asset_refs repository
utils/api_server.py               wire validator (asset_id/kind/source_url/mime_type)
```

DB schema `media_asset_refs(review_chain_id, asset_id, kind, source_url,
mime_type, file_id, file_unique_id)` is the single state source and stays
unchanged.

## 3. Target

```text
telepost/domain/media.py
  MediaAsset          canonical facts + optional Telegram cache facts
  DeliveryVariant     enum: TELEGRAM_FILE_ID | REMOTE_URL | LOCAL_UPLOAD
```

Repository returns `MediaAsset` objects; `delivery_planner` consumes them and
emits typed variants. Wire contract, DB schema and `media_json`/`documents_json`
are untouched.

## 4. Migration slice (ADD -> ADAPT -> VERIFY)

1. ADD `telepost/domain/media.py`:
   - `MediaAsset` frozen dataclass (`asset_id`, `kind`, `source_url`,
     `mime_type`, optional `file_id`/`file_unique_id`);
   - `from_wire(dict)` and `from_row(row)` constructors (same validation
     rules that live in `_validate_media_assets` today);
   - `DeliveryVariant` enum with the three planner strategies.
2. ADAPT `media_assets.py` repository to return `MediaAsset`; update the three
   consumers (`api_server`, `delivery_planner`, tests) in the same PR.
3. VERIFY: existing 964 tests + one new unit test per constructor; production
   evidence = Batch 4 E2E rows + `delivery-plan` output (no behavior change
   expected, regression-only).

## 5. Explicitly out of scope

- No new tables / second state source.
- No wire contract change (TelePost still accepts only
  `{asset_id, kind, source_url, mime_type?}`).
- No copyMessages / Telegram-URL / multipart-upload delivery work yet
  (that is Batch 7/8; this RFC only gives the variant a type).
- PixivFlow side untouched.

## 6. Gate (passed)

Batch 4 production E2E evidence (2026-09-21 self-test, TelePost 2.57.1):

- Real multipart submission with canonical `media_assets` (PixivFlow 2.43.1
  ad-hoc run) created bot1 review 122; `media_asset_refs` persisted 10 rows
  (`i.pximg.net` originals, empty `file_id`) under `chain-122`.
- Blocking defect found and fixed first (TelePost 2.57.1, PR #221): new
  reviews kept an empty `review_chain_id` until the next restart backfill, so
  `_persist_media_assets` silently skipped persistence.
- `GET /api/bot1/v1/reviews/122/delivery-plan` returned 10 planned entries
  (staged Telegram file_ids win by design; the remote_url + media-proxy path
  remains the verified fallback, production-proven in the 2.57.0 acceptance
  with a real `sendPhoto` 200 image/jpeg).
