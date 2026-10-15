# Agent Note: Liability analysis before all clarification replies

Status: implemented

## Problem

A single pending-question count makes conditional liability suggestions wait for every user reply. Review application fields such as a telephone number also delay completed workbench results even though they do not change accident responsibility.

## Decision

Clarification reports separate counts for factual blockers, conditional facts and review intake fields. The six stages can produce conditional or undetermined results with questions pending. Unconditional supported suggestions require resolved consequential facts. Existing party-level causal, legal and blocking-issue validation still applies, and results with unresolved facts must state limitations. Pending questions remain pending until answered or resolved by evidence; the program never invents unknown replies.

Clear factual replies and withdrawals invalidate evidence and downstream stages. Both workbench displays and report exports wait for that review. Application completeness remains a separate requirement for the complete review application; incomplete intake does not prevent an analysis result or a review opinion. A completed task is a saved result for its input version, not proof that all facts are known.

## Alternatives considered

**Require every reply before producing a result.** This prevents users from seeing usable conditional analysis and couples application contact fields to responsibility.

**Treat every missing reply as unknown.** This invents user answers and prevents the interface from retaining genuinely unanswered questions.

**Allow unconditional suggestions whenever a task finishes.** This confuses workflow completion with established facts and removes meaningful responsibility checks.

## Consequences

Users can finish a limited analysis and later supply more evidence. The workbench keeps its existing billing policy: a new analysis after a completed task is a recomputation task. Completion checks are shared by the browser, report route and task runner. Older projections without separate counts conservatively use the total count for supported conclusions while permitting explicit limited results.

## Testing

Keyless engine tests save a valid conditional scenario with four unanswered facts, reject unsupported certainty and missing limitations, preserve blocking causal issues, and invalidate the result on a later reply. Registered-tool output has an owner-local clarification fixture. Native Harness verification checks an undetermined result with a pending question and report download with missing application fields. These checks do not measure live model compliance.
