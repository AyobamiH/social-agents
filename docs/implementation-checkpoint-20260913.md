# Publication concurrency repair checkpoint — 13 September 2026

The full engineering blueprint remains the completion scope. This change closes
a newly reproduced database concurrency defect; it does not complete the
remaining billing, job ownership, connection lifecycle, generation, fairness,
provider or account-acceptance work in [the full register](implementation-checkpoint-20260912.md).

## Reproduction and repair

App PR #9 merged as c46dff045e79b537661c48b92b5f0b32c7be6b4b. Its post-merge
integration failed when eight concurrent publishers produced no provider write.
That run did not retain SQLSTATE diagnostics, so its exact historical cause
cannot be recovered from the assertion alone.

A controlled test against the unchanged schema reproduced a begin/claim
deadlock with PostgreSQL SQLSTATE 40P01:
https://github.com/AyobamiH/oneclickpostfactory/actions/runs/34741743158

Claims lock queue then intent. Other publication mutations locked intent or
attempt first, then needed the queue row, including the attempt foreign-key
check. The companion forward migration takes the tenant-owned queue lock first
in every publication mutation. This serialises one publication without blocking
unrelated queue identities.

The worker requires publication-queue-lock-order-v1 before dispatch. The v1
contract migration identity remains compatible with the previous worker, while
the database advertises lock_order_migration=20260913061000 separately.

## Paired review and verification

- Canonical worker PR: https://github.com/OneClickPostFactory/social-agents/pull/11
- Schema/app follow-up: https://github.com/AyobamiH/oneclickpostfactory/pull/10
- The app workflow pins this worker candidate and checks out the canonical
  OneClickPostFactory/social-agents repository.
- Controlled begin/claim and release/claim contention, twenty rounds of eight
  Worker claimers, and the existing publication failure scenarios run against
  real isolated Supabase/Postgres with provider transport intercepted.
- A missing lock-order capability must block the worker before provider dispatch.
- Passing receipts belong to the exact commits recorded in the paired PR checks.
  Do not infer a pass from the existence of this checkpoint.

Promote schema first, then the paired worker, through the existing guarded
release process. The old deployed worker remains compatible with the additive
schema. Do not re-enable generation or provider dispatch as part of source
integration. No live-provider acceptance or production migration is claimed.

Next implementation slice: durable logical agent-job identity and fenced
terminal ownership (D05 and the remaining D09), with real database competing
claim/recovery tests before consumer promotion.
