---
kind: upgrade-guide
description: Stage-save validation failures become unsaved results, and review schemas require an explicit query.
---

# Stage validation and review schema queries

## Change

After upgrading from plugin 0.1.3, `traffic_case_save` returns `{saved:false, code:"validation_failed", errors, totalErrors, omittedErrors, correction, stage}` for invalid payloads instead of throwing. These results never write a case. Runtime and storage failures still throw. Successful saves retain their existing fields. Stage queries additionally return `rules` describing business checks.

Ordinary `traffic_case_read` calls no longer include `reviewContract`. Query a single review schema with `reviewSection:"intake"` or `reviewSection:"analysis"`; this parameter is mutually exclusive with `stage` and needs no case ID. Stored cases need no migration.

## Migration

1. Update callers to check `saved` before treating a stage as complete. Correct the reported paths and resubmit; a successful tool invocation alone does not mean the payload was saved.
2. Replace implicit `reviewContract` reads with `traffic_case_read({reviewSection:"intake"})` or the analysis equivalent.
3. Rebuild and reinstall the plugin, fully restart Harness, and create a new session. Confirm that `traffic_case_read({stage:"duties"})` returns `rules` and that ordinary reads omit `reviewContract`.

For local verification, run `npm test`, `npm run build`, and `node --import tsx tests/tools.ts --built` from the plugin directory.
