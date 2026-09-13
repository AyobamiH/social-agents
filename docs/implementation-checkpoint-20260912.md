# Implementation checkpoint — 12 September 2026

## Recovered baseline

The September 6 local branch is superseded. Continue from backend
`e9eb7fa8b2d10146480377e8c51854991c728194` and app/schema
`19a402ca28c61b53d17a6b12f14ca047ed5917e9`. Reapplying that old branch would
regress the manual deployment controls and duplicate already merged work.

The persistent staging rehearsal and production schema cutover are complete
according to the September 9 rollout attestation in
[`reliability-repair-progress.md`](reliability-repair-progress.md). The guarded
[deployment run](https://github.com/OneClickPostFactory/social-agents/actions/runs/34354662402)
confirms Worker version `773bb17d-59ef-484d-ae74-2f7c004e3447`, from
`3a27a993742151a6558089c9ab0ade6b1a762ba4`, with generation and provider dispatch
disabled. This is an inert canary, not end-to-end product acceptance. No new
production deployment, schema change, paid API call or social post was made
during this continuation.

## Repairs in this continuation

The worker cancels angle extraction through the HTTP transport, response read
and retry wait. It awaits settlement before releasing the source claim. This
prevents abandoned local work; cancellation cannot guarantee that a provider
has not already incurred a charge. Durable generation accounting remains a
separate release requirement.

Each scheduling stage, tenant and due queue row has an error boundary. A failed
fetch, tenant lookup, recovery query or log write cannot suppress independent
publish work. `SchedulerStats.errors` reports failures by stage. Existing
entitlement, canary, immutable hold and publication ledger gates still apply.
Scheduling remains serial; this change does not provide durable fairness,
enqueue uniqueness, or an overall tick deadline.

The build uses Node's `--import tsx` entrypoint, avoiding the tsx CLI's unnecessary
IPC listener. Both new regression files are included in the required test command.
Two existing static wiring assertions now accept the scheduler's stage wrapper;
their prohibition on legacy publication reconciliation remains intact.

The companion app repair checks billing database results, requires immutable
customer ownership, makes X OAuth state single use, and permits authenticated
credential clearing without paid access. Webhook acknowledgement and delivery
order are separate concerns; the former is repaired and the latter still needs
the durable inbox/projection release described below.

## Reviewed completion plan

Every phase must leave its current consumer, schema contract, negative tests,
rollout controls and recovery procedure executable before moving to the next.
Merge and deployment are distinct checkpoints.

| Phase | Current state | Remaining implementation and acceptance gate |
| --- | --- | --- |
| Release identity and CI | Merged; inert deployment verified | Deploy only an approved exact SHA through the existing guarded workflow. |
| Tenant runtime and database claims | Scope isolation, source/angle fencing and publication ledger merged | Add durable job-enqueue uniqueness and terminal job ownership; demonstrate competing Workers cannot create duplicate logical jobs or finish a replacement owner's job. |
| Worker cancellation and isolation | Implemented in this repair | Full CI and exact-commit PR checks; retain all publication ambiguity tests. |
| Billing | Error acknowledgement, ownership and period compatibility repaired in companion app branch | Environment-owned configuration and environment/customer mapping; durable event inbox; serial canonical Stripe reconciliation; atomic projection/audit commit; checkout intent and lifetime trial eligibility. Test duplicate, reversed, concurrent and crash/replay deliveries without changing another tenant or environment. |
| Connection lifecycle | Single-use X callback and unpaid credential clearing implemented | Credential versions and compare-and-swap persistence for callback, refresh, reconnect and disconnect across app and Worker. A delayed refresh/callback must never restore a disconnected credential. |
| Generation | Claims and cancellation exist | Reserve a durable generation operation and budget before any paid request; classify ambiguous attempts; preserve outputs; enforce one spend for a logical operation across restarts. Never infer a durable budget from best-effort logs. |
| Scheduling | Tenant/stage failures isolated | Durable cursor, bounded tenant batches, per-tenant fairness, exact enqueue identity and queue-age monitoring. Test a healthy tenant behind more than one page of blocked rows. |
| Providers and ingestion | Existing retirement/quarantine boundaries enforced | Validate the installed Reddit connector end to end. Establish the hosted tenant contract for Threads/Instagram without reviving retired adapters. Verify current LinkedIn compatibility and tenant X identity. Facebook needs an explicit supported target; legacy Groups and frontend Page credentials are not interchangeable. |
| Product status and release acceptance | Health and ledger provide partial truth | UI consumes connection, generation and per-platform publication states, including unknown outcomes. Align marketing with enabled capabilities. Complete one authorised scheduled canary per supported provider, then a monitored soak and recovery drill. |

## Original defect register reconciliation

“Repaired here” means code and regression coverage on the repair branch. It does
not mean deployed. “Merged” refers to the recovered baseline; it does not prove
live account compatibility or every failure mode.

| Finding | Current disposition |
| --- | --- |
| D01 release/deploy verification | Merged: manual exact-SHA gate and full CI. |
| D02 hosted Meta publisher gap | Open; retired adapters remain closed. |
| D03 shared tenant runtime | Runtime scope isolation merged; connection versioning remains. |
| D04 angle/source races | Atomic database claims and fenced finalisation merged. |
| D05 job creation races | Open for worker-owned enqueue paths. |
| D06 ambiguous database mutation retries | Merged: ordinary mutations single attempt; explicit idempotent RPC retry. |
| D07 provider success followed by bookkeeping failure | Publication ledger/executor merged; ambiguity cannot authorise resend. |
| D08 source URL used as publication identity | Removed from production reconciliation; exact queue/attempt identity merged. |
| D09 stale recovery ownership | Publication/source/angle protections merged; terminal agent-job fencing remains. |
| D10 uncancelled extraction deadline | Repaired here, including transport/body/backoff cancellation tests. |
| D11 generation spending from best-effort logs | Open: durable budget and generation operation ledger required. |
| D12 scheduler failure propagation | Repaired here at stage, tenant and row boundaries. |
| D13 first-page starvation | Open: durable fair scheduling and bounded cursors required. |
| D14 incomplete regression command | Full existing suite merged; new tests added to the same required command. |
| D15 readiness/typed UI truth | Health repaired; complete application state projection remains. |
| D16 ignored billing writes | Companion repair returns failures and requires affected profile rows; durable inbox remains. |
| D17 Stripe arrival-order projection and late deduplication | Open; trial reminders are now audit-only, but general ordering still needs transactional reconciliation. |
| D18 Stripe environment selection/partition | Incoming signed mode checked in companion repair; deployment selection and database partition remain open. |
| D19 first email customer fallback | Removed in companion repair; metadata conflicts fail closed for support review. |
| D20 duplicate checkout/trials | Open; customer-create idempotency alone is not checkout/trial protection. |
| D21 paid access required to clear credentials | App/API restriction removed in companion repair; disconnect/refresh fencing remains. |
| D22 implicit platform enablement | Explicit stored-true policy merged in app and Worker. |
| D23 concurrent X callback reuse | Atomic unexpired DELETE RETURNING implemented in companion repair. |
| D24 LinkedIn compatibility | Open; verify current Posts API contract before claiming availability. |
| D25 unsupported learning/marketing claims | Open: reconcile product promises with implemented evidence. |
| Additional: Stripe period fields | Companion repair reads current subscription item periods, with legacy-event compatibility. |

## Evidence and limitations

Local worker validation: `npm run ci` passes, including the new transport and
real scheduler failure tests. App validation and the exact review links are
recorded in the companion repository's September 12 checkpoint.

Existing production data was not read again during the source repairs. The
148-row/11-hold inventory is the September 9 attestation, not a new snapshot.
The 16 real-Postgres scenarios are prior rehearsal evidence, not new tests run
in this continuation. The new tests intercept external transport and make no
paid or public calls.

There is no defensible unconditional guarantee that the entire service will
work after these patches. Completion means measured success for the declared
platforms and failure/recovery contracts above, followed by monitored operation.
