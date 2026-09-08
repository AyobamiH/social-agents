# Reliability repair progress

This file records implementation status, not production deployment or provider readiness. The final exact-SHA CI receipts are recorded on the relevant pull requests. A passing component test is not live account evidence.

## Sequence 1: release identity and complete CI gate

Merged to upstream through PR #2. `npm run ci` gates typecheck, the complete normal regression suite and the compiled-runtime smoke check. Deployment invokes that same gate. Cloudflare version metadata and the Git SHA are exposed separately from provider readiness.

Hosted Threads and Instagram remain unavailable; Facebook remains paused; LinkedIn compatibility is unverified; X requires a tenant-owned connection. No production deployment is claimed here.

## D03 containment and async runtime isolation

Upstream PR #3 added a shared per-isolate exclusive gate for scheduled and authenticated tick drains. Its regression proves overlapping drains do not enter mutable tenant runtime concurrently and rejection releases the gate.

Upstream PR #4 added async-local configuration and token callback isolation. Its recorded pre-merge head was `f68e4434efc18053d11c85ff1b3d2dd334c5dc3d`; merge commit `033b9b578c120bec0b725311eba1db3d3bfe5530`.

The Worker installs scoped configuration accessors after loading Cloudflare bindings. Each SaaS drain runs inside `AsyncLocalStorage`. Tenant values and Threads/LinkedIn/X token-persistence callbacks stay in the originating execution. Local single-tenant behaviour is retained outside that scope. `processPendingSupabaseJobs()` remains serial and the exclusive drain gate remains in place.

This addresses cross-execution process-global leakage. It is not a claim that every provider now uses explicit immutable client arguments, or that credential-version/disconnect fencing exists. Those connection-lifecycle contracts remain separate work.

## D22: explicit platform activation

Present in this branch: only exact persisted boolean `true` enables a platform. Missing rows, fields, null and false fail closed. The schema-owner bootstrap also contains default-false settings and matching UI semantics. Existing legacy true values are not mass-rewritten because their original intent cannot be inferred safely.

## D04/D05/D06: source and angle claims and safe transport

This branch is stacked on `codex/atomic-worker-claims`, head `984d0afa1fdfd696153fa8615615b1e2d42596e3`. That dependency introduces the typed worker-claims contract, database-owned source/angle leases and fencing, atomic generation finalisation, and explicit Supabase RPC retry semantics.

Ordinary ambiguous mutations are single-attempt. Only reads and RPCs whose exact request identities are designed to be idempotent opt into retries. This does not claim that every agent job/enqueue path already has durable uniqueness or fencing.

## D07/D08/D09: connected publication execution

The hosted Worker consumer is now wired in `codex/publication-ledger-v1`, fork PR `AyobamiH/social-agents#4`, not merely a collection of unused helper modules.

### Execution boundary

`publishQueueRow()` delegates to `executePublication()`:

1. Probe the exact `publication-ledger-v1` schema/capability contract.
2. Read existing outcome by tenant and queue identity. Accepted, rejected, dispatching or unknown publications never become a blind resend.
3. Reject unavailable hosted Meta and paused Facebook before claim, token refresh or paid media work.
4. Claim one immutable queue snapshot with a caller-owned token and fencing version.
5. Prepare credentials, identify the provider account, and recheck entitlement, explicit enablement and scheduled automation/due time.
6. Persist the dispatch attempt before the provider write.
7. Publish only the database snapshot and make one provider publishing request per attempt.
8. Record acceptance and the queue/history projection transactionally through the ledger.

Provider dispatch and database finalisation have different error boundaries. A database failure after provider success cannot be interpreted as a provider rejection. Lost begin-dispatch responses cause no provider call. Uncertain provider outcomes stay unknown and non-retryable.

Post-acceptance angle/telemetry failures cannot reopen sending. Where possible the result includes the exact history ID as well as intent, attempt and provider IDs. Provider acceptance and later visibility verification remain separate.

### Recovery boundary

`stalePublishJobResult()` calls exact ledger reconciliation. The source-URL/platform/time history matcher has been removed from production orchestration. `recoverStalePublications()` also scans orphan claims/dispatches independently of parent job status, including publish-all work.

Expired pre-dispatch ownership may be released with its token/fence. Stale dispatches become unknown. Legacy publishing rows without ledger identity remain quarantined, not relabelled failed so they can be retried.

A delayed positive provider response can resolve its own unknown attempt using exact attempt ID, dispatch operation ID, external object ID and recorded response evidence. Negative search results are not sufficient evidence. Visibility is not inferred from acceptance.

### Adapter corrections and preserved limits

X no longer refreshes and repeats POST after an auth-looking response. Read-only identity verification may refresh after explicit HTTP 401. LinkedIn uses its returned object ID or `x-restli-id`, never the placeholder `posted`.

This does not migrate LinkedIn to the newer Posts API, restore Meta, grant provider scopes, or implement new formats. No provider is newly enabled. Connection rotation/removal version fences and full revision-approval lifecycle still need their own release evidence. The ledger guarantees the claimed snapshot is what is sent; it does not manufacture an earlier approval record.

### Test boundary and ownership

The normal regression gate includes executor fault injection, provider single-dispatch checks and delayed receipt reconciliation. `test/publication-database.integration.ts` exercises the actual Worker, encryption, async tenant contexts, Supabase REST/RPC transport and a real local Postgres database. Provider network calls are intercepted: this is integration/failure evidence, not live-provider evidence.

The cross-repository integration workflow belongs to the private schema-owner repository, `AyobamiH/oneclickpostfactory`, at `.github/workflows/publication-worker-integration.yml`. It checks out an exact public Worker SHA and its own schema. No broad cross-repository secret is needed and no private schema is copied into this public repository. The integration must be rerun with a new exact Worker pin whenever the consumer changes.

The one-time hash-guarded source-edit workflow and script were removed after committing the source delta. No write-enabled test/codemod workflow remains from this cutover.

## Production remains gated

Neither schema nor consumer is deployed by this branch. Before rollout: review the paired PRs, establish canonical schema ownership, apply to isolated staging first, verify the capability receipt, drain old publication dispatch owners, quarantine unresolved legacy publications, then test a bounded authorised cohort. Never run old and new executors as competing owners of the same queue row. Rollback must preserve ledger-owned unknown states and must not replay the legacy queue.

Remaining programme work includes connection lifecycle/version fences, billing inbox and entitlements, durable generation budgets, fair scheduling and typed UI recovery, provider restoration/compatibility, and account-authorised scheduled canaries. Do not describe the whole SaaS as production-repaired based on this publication slice alone.
