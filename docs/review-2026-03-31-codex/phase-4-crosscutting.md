# Phase 4 Cross-Cutting Review

## Systemic Issues

### 1. Async failure handling is inconsistent across command paths
- Read paths usually return `{ ok: false, error }`.
- Several write paths rely on implicit success and omit rejection handling.
- Result: the most important operations are the least deterministic under storage faults.

### 2. Persistence and in-memory publication are not ordered consistently
- Some flows rebuild indexes from durable state.
- New-version creation publishes to `state.versionIndex` / `state.versionsByPage` before durable commit.
- Result: transient runtime state can diverge from IndexedDB after any failed write.

### 3. Retention depends on metadata freshness, but reuse paths skip metadata refresh
- Cleanup uses `lastSeenAt`.
- Exact-signature reuse avoids storage writes entirely.
- Result: deduplication and retention policies work against each other.

## Areas Not Deeply Covered
- Browser-network edge cases beyond static inspection, such as CSP/CORS behavior for `fetchSourceMap`
- Packaging/release automation beyond basic file-copy/zip correctness
- Localization completeness beyond the keys exercised by tests
