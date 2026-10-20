---
kind: upgrade-guide
description: Stage-save validation failures become unsaved results, and review schemas require an explicit query.
---

# Stage validation and review schema queries

## Change

After upgrading from plugin 0.1.3, `traffic_case_save` returns `{saved:false, code:"validation_failed", errors, totalErrors, omittedErrors, correction, stage}` for invalid payloads instead of throwing. These results never write a case. Runtime and storage failures still throw. Successful saves retain their existing fields. Stage queries additionally return `rules` describing business checks.

Ordinary `traffic_case_read` calls no longer include `reviewContract`. Query a single review schema with `reviewSection:"intake"` or `reviewSection:"analysis"`; this parameter is mutually exclusive with `stage` and needs no case ID. Stored cases need no migration.

Liability validation collects independent errors across parties, scenarios and exclusions. Errors use field paths, `missingValues` for missing IDs and `relatedPaths` for upstream blockers. Each reference list is limited to 20 entries with an omission count; the response still returns at most 12 errors.

Causal conclusions accept `undetermined` for an unknown contribution with `score:null`. `not_established` now requires adopted exclusion facts and no consequential unresolved conditions in the fault or related issues. Undetermined causes cannot establish responsibility or support exemption in the main conclusion. When evidence has not been updated, removing fault conditions or relaxing causal investigation requirements, issues or conclusions requires `revisionBasis:{reason,factIds}` with adopted facts. Existing facts may support an explicit correction; unresolved upstream issues still constrain conclusions. This records the basis but does not assess the sufficiency of free-text reasoning.

## Migration

1. Update callers to check `saved` before treating a stage as complete. Correct the reported paths and resubmit; a successful tool invocation alone does not mean the payload was saved.
2. Replace implicit `reviewContract` reads with `traffic_case_read({reviewSection:"intake"})` or the analysis equivalent.
3. Rebuild and reinstall the plugin, fully restart Harness, and create a new session. Confirm that `traffic_case_read({stage:"duties"})` returns `rules` and that ordinary reads omit `reviewContract`.
4. Use causal `undetermined` for insufficient grounds instead of marking a cause excluded. Recompute causal and liability results in existing cases; old conclusions remain readable and are not automatically reassessed. Supply `revisionBasis` for corrections that relax recorded requirements without updating evidence.
5. Correct all reported liability fields together. If the facts cannot support a reasonable main scenario, save `recommendationType:undetermined`, all parties as 暂无法判断, `primaryScenarioId:null`, empty scenarios/exclusions and explanatory limitations. Complete this limited analysis before asking for further facts; do not rewrite upstream requirements just to obtain a grade.

For local verification, run `npm test`, `npm run build`, and `node --import tsx tests/tools.ts --built` from the plugin directory.
