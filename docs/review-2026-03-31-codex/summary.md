# Review Summary

## Totals
- Confirmed findings: 5
- High: 2
- Medium: 3

## Highest-Priority Findings

### High
1. `src/background/sessions.mjs:116` reuses matching versions without refreshing `lastSeenAt`, so active versions can be pruned as stale.
2. `src/background/runtime.mjs:190`, `src/background/runtime.mjs:207`, `src/background/runtime.mjs:217`, `src/background/runtime.mjs:226` keep async message channels open but do not reply on rejection.

### Medium
1. `src/background/runtime.mjs:301` registers listeners before persisted settings load, so a disabled detector can still collect during cold start.
2. `src/background/sessions.mjs:129` and `src/background/storage.mjs:563` publish new versions into memory before durable commit, allowing ghost entries after failed writes.
3. `src/background/storage.mjs:660` invalidates whole versions during compaction when only part of the version is missing, and mislabels the condition as `all_maps_missing`.

## Validation
- `npm test` passed locally: 183 tests across 5 files.
- The existing suite does not cover the failure paths behind the findings above.

## Recommended Next Order
1. Fix message-handler rejection responses.
2. Fix `lastSeenAt` refresh on reused signatures.
3. Reorder startup initialization so settings load gates detection.
4. Make new-version creation atomic with respect to in-memory index publication.
5. Tighten compaction semantics and add corruption tests.
