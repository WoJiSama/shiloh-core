# Message Pipeline Architecture

This document describes the **Yunzai plugin pipeline** and its `ytbot:message_pipeline:` jobs. The standalone Core uses a separate inbox and ledgers; its configuration is documented in [Agent bindings](agent-bindings.md). Current delivery and verification status is maintained in [Project status](../project-status.md).

## Purpose

This pipeline owns message capture, recent context, NDJSON archives, media relay jobs, and OneBot delivery. It exists outside the Yunzai app dispatcher because the dispatcher can reject duplicate-looking messages before any app plugin runs. In particular, its duplicate key does not contain `group_id`, so the same user forwarding the same card to two groups can otherwise lose one event.

## User Invariants

1. The same Bilibili or Douyin share sent to two groups creates two independent delivery jobs.
2. A slow download in one group does not block capture or delivery in another group.
3. Reprocessing the same retained event uses consumer identity checks to avoid duplicate recent-context rows or NDJSON records; this is not a cross-system delivery guarantee.
4. A media resource failure still produces a merged-forward information node when stable card data exists.
5. A OneBot response is never marked `sent` without a valid `retcode=0` receipt.
6. A transport exception with an unknown delivery outcome is not retried automatically, because doing so can duplicate a visible group message.
7. AI chat, dice, moderation, Excel, image jobs, and command routing remain in the app dispatcher and do not own archive or media delivery side effects.

## Ownership

```text
Bot EventEmitter
  -> EventEnvelope capture
  -> Redis event job
      -> recent-context upsert
      -> NDJSON append-once
      -> optional emoji auto-collection dispatch
      -> media delivery enqueue
          -> metadata refresh
          -> lowest-resolution media assembly
          -> per-group serial delivery
          -> DeliveryGateway / OneBot receipt
```

- `index.js` installs the only raw `message` and `notice` listeners.
- `MessagePipeline` owns event jobs and consumer progress.
- `MessageManager` owns recent Redis context only.
- `MessageArchiveManager` owns NDJSON files only.
- `MediaOutbox` owns media refresh, resource assembly, retry state, and per-group ordering.
- `DeliveryGateway` is the only automatic media path that calls `send_group_forward_msg`.
- `apps/MessageManager.js` keeps query and administration commands; it is not a catch-all recorder.

No durable job contains the original Yunzai event object, bound methods, `e.reply`, `e.group`, or `e.friend`. The gateway resolves the live bot from `Bot.bots[botId]` when delivery runs.

## Identities

Event identity:

```text
v1:botId:postType:conversationType:conversationId:messageId
```

When OneBot does not provide a message ID, the last component is a bounded hash that includes the conversation, sender, timestamp, and raw message.

Media delivery identity:

```text
v1:platform:botId:groupId:messageId-or-eventId
```

URLs are data, never idempotency keys. Temporary playback URLs are refreshed during each delivery attempt and are not persisted.

## State Machines

Event jobs:

```text
pending -> processing -> completed
                    \-> retry_wait -> processing
                    \-> failed
```

Each event stores independent `recent`, `archive`, `media`, and `emoji` consumer states. Storage retries are idempotent by `event_id`; one consumer failure does not roll back successful consumers.

Delivery jobs:

```text
pending -> processing -> sending -> sent
                    \-> retry_wait -> processing
                    \-> failed
                    \-> uncertain
sending -- interrupted or receipt not persisted --> uncertain
```

Jobs record attempts, retry time, lease owner, lease expiry, last error, OneBot retcode, uncertainty, and the final receipt. Locks use Redis compare-and-delete and compare-and-expire scripts. Recovery waits for an unexpired lease instead of stealing it from a live or hot-reloaded worker.

## Delivery Semantics

- Returned non-zero OneBot retcodes are known failures and may retry up to the configured limit.
- A failure only retries when it is marked retryable, is not uncertain, and has remaining attempts. These are the plugin gateway's rules, not a retry contract for every Core tool or platform operation.
- A thrown transport error or malformed/missing `retcode` receipt has an unknown outcome. The media job becomes `uncertain` and is not retried automatically.
- The legacy plugin gateway accepts `retcode=0` and persists `sent`; it does not reject that receipt solely because a message ID is missing. Duplicate events reuse the stored state while the record is retained. A `sent` job alone therefore does not prove the acceptance gate below, which also requires a platform message ID and a visible message.
- An interrupted `sending` job, or a confirmed send whose receipt could not be persisted, becomes `uncertain` on handling/recovery. It does not resume sending automatically.

## Reliability Boundary

The pipeline provides retained job identity, idempotent storage consumers, bounded retries for known failures, and restart recovery for persisted, unexpired work that is safe to continue. It does **not** guarantee strict cross-system exactly-once delivery or end-to-end zero message loss.

- **Before persistence:** raw capture schedules Redis persistence asynchronously. A process failure before that write completes, or a failed initial write, can leave no durable event to recover. The initial capture failure is logged; this entry point does not replay it automatically.
- **Retention:** `messagePipeline.eventTtlMinutes` defaults to 360 minutes and `deliveryTtlHours` to 24 hours. `RedisJobStore.create/save` applies these TTLs to unfinished as well as terminal jobs. Work can expire during downtime; recovery scans only records that still exist. Expired records also stop providing deduplication history.
- **Platform side effects:** OneBot has no general idempotency token and cannot atomically commit a send with Redis. A crash after saving `sending` can happen before the platform accepts the message or after it accepts it but before the receipt is stored. Recovery cannot distinguish the two, so it preserves uncertainty and stops automatic resending; delivery may remain incomplete.
- **Durability:** recovery depends on Redis retaining the data. Process restart checks do not prove survival of Redis data loss or a power failure.
- **Standalone Core:** it has separate storage and operation-specific retention rules, so the plugin TTLs above do not describe Core. Its OneBot adapter also has a 256-event receive backlog before durable admission; when full it rejects new events and emits `event_not_queued`. A durable inbox cannot recover an event that never reached it. Core's unknown receipts likewise do not establish exactly-once delivery.

Implementation anchors: `src/modules/messaging/infrastructure/redisJobStore.ts`, `messagePipeline.ts`, `mediaOutbox.ts`, and `src/adapters/oneBotConnection.ts`.

## Ordering And Concurrency

- Raw capture is independent of app-plugin priority and returns immediately after scheduling Redis persistence.
- Event work is bounded globally and serialized by conversation where ordering matters.
- Media delivery is serialized by group and bounded across groups.
- Downloads, base64 conversion, and OneBot sends never hold the Yunzai app dispatcher.
- Emoji auto-collection uses its own bounded background semaphore and cannot delay recent/archive consumers.

## Failure Policy

| Failure | Result |
| --- | --- |
| Redis event create fails | Log capture failure; no business consumer fabricates success |
| Media metadata refresh fails | Use the persisted card snapshot |
| Cover/video assembly fails | Send stable information and page data with a visible degradation note |
| Recent Redis read fails | Retry; never overwrite history with an empty array |
| NDJSON retry | Identity index prevents duplicate append |
| Known OneBot retcode failure | Retry with backoff, then retain `failed` state |
| Unknown OneBot outcome or interrupted `sending` | Retain `uncertain`; do not auto-retry |
| Restart or hot reload | Recover persisted, unexpired, safe-to-continue work after its lease is available |
| Unfinished job expires | No job remains for recovery; the configured TTL also bounds deduplication history |

## Operations

- `.消息管道状态` shows event and delivery state counts plus recent failures.
- `.消息管道状态 <群号>` limits the view to one group.
- Startup must log `[MessagePipeline] 原始事件捕获、持久任务和媒体 outbox 已启动`.
- Redis keys use the `ytbot:message_pipeline:` prefix and expire according to `messagePipeline` configuration.
- Before deployment, stop only after active image jobs are zero, back up the plugin, remove obsolete recorder files, deploy without AppleDouble files, then restart once.

## Acceptance Gate

A release is not accepted from unit tests alone. Send the same real share to both target groups and verify, for each group:

1. a distinct event job exists;
2. a distinct delivery job exists;
3. the delivery reaches `sent`;
4. the receipt has `retcode=0` and a message ID;
5. one visible merged-forward message appears;
6. no old recorder or relay path emits a duplicate.

## Extension Rule

New media platforms implement four bounded operations: detect from serialized envelope data, refresh metadata, build relay segments, and format stable information. They enqueue through `MediaOutbox` and send through `DeliveryGateway`; they must not add another catch-all app plugin or retain the raw Yunzai event.
