/** Persistent user replies and the question queue derived from recorded analysis gaps. */
import type { CaseRecord } from './engine.ts';
import type { Causation, Duties, EvidenceAnalysis, Faults, QuestionReply, Registration, Stage } from './schema.ts';
import { reviewQuestions } from './review-model.ts';

export interface CaseQuestion {
  itemId: string;
  question: string;
  impact: string;
  severity: 'blocking' | 'conditional';
  partyId: string | null;
  factIds: string[];
  stages: Stage[];
  /** Missing on legacy factual questions. */
  target?: 'fact' | 'review_intake';
}

export interface QuestionAnswer extends QuestionReply {
  id: string;
  questionRecord: CaseQuestion;
  receivedAt: string;
  /** Null until a substantive reply or withdrawal has been incorporated into the evidence stage. */
  appliedAtRevision: number | null;
}

/**
 * Match a factual item across stages, including questions from older records without item ids.
 * @param left one question
 * @param right the other question
 * @returns whether the ids or the nonempty sets of referenced facts agree
 */
export function sameQuestion(left: CaseQuestion, right: CaseQuestion): boolean {
  return left.itemId === right.itemId || (
    left.target !== 'review_intake' && right.target !== 'review_intake' && left.factIds.length > 0 && right.factIds.length > 0 &&
    [...new Set(left.factIds)].sort().join('|') === [...new Set(right.factIds)].sort().join('|')
  );
}

/**
 * Select the latest reply to each factual item, preserving earlier replies in the case history.
 * @param record persisted case
 * @returns the current replies in recording order
 */
export function latestAnswers(record: CaseRecord): QuestionAnswer[] {
  const result: QuestionAnswer[] = [];
  for (const answer of record.questionAnswers ?? []) {
    const index = result.findIndex((a) => sameQuestion(a.questionRecord, answer.questionRecord));
    if (index >= 0) result.splice(index, 1);
    result.push(answer);
  }
  return result;
}

/**
 * Collect consequential factual questions from usable stages; rule gaps and details remain investigation items.
 * @param record persisted case
 * @returns deduplicated questions, with blocking questions first
 */
export function collectQuestions(record: CaseRecord): CaseQuestion[] {
  const result: CaseQuestion[] = [];
  const reg = record.stages.registration.payload as Registration | null;
  const usable = (stage: Stage) => ['analyzed', 'needs_investigation'].includes(record.stages[stage].status);
  const evidence = usable('evidence') ? record.stages.evidence.payload as EvidenceAnalysis : null;
  const facts = evidence?.facts ?? [];
  const add = (question: CaseQuestion) => {
    if (question.factIds.length && question.factIds.every((id) => facts.some((f) => f.id === id && f.status === 'supported'))) return;
    const previous = result.find((q) => sameQuestion(q, question));
    if (!previous) result.push(question);
    else {
      previous.stages = [...new Set([...previous.stages, ...question.stages])];
      previous.factIds = [...new Set([...previous.factIds, ...question.factIds])];
      if (question.severity === 'blocking') previous.severity = 'blocking';
      if (!previous.impact.includes(question.impact)) previous.impact += `；${question.impact}`;
    }
  };
  for (const question of reviewQuestions(record)) add(question);
  for (const q of evidence?.openQuestions ?? []) add({
    itemId: q.itemId, question: q.prompt, impact: q.impact, severity: 'conditional',
    partyId: q.partyId, factIds: q.factIds ?? [], stages: ['evidence'],
  });
  for (const stage of ['duties', 'causation'] as const) {
    if (!usable(stage)) continue;
    const payload = record.stages[stage].payload as Duties | Causation;
    for (const issue of payload.issues) {
      if (!['fact_gap', 'evidence_conflict'].includes(issue.kind) || issue.severity === 'supplementary') continue;
      add({
        itemId: issue.itemId ?? (issue.factIds.length === 1 ? `fact.${issue.factIds[0]}` : `${stage}.${issue.id}`),
        question: issue.question, impact: issue.impact, severity: issue.severity,
        partyId: null, factIds: issue.factIds, stages: [stage],
      });
    }
  }
  // A withdrawn or uncertain reply remains relevant while its recorded fact is still unresolved.
  for (const answer of latestAnswers(record)) {
    if (answer.questionRecord.factIds.some((id) => facts.some((f) => f.id === id && f.status !== 'supported'))) {
      add(structuredClone(answer.questionRecord));
    }
  }
  const addFact = (factId: string, stage: Stage, impact: string, partyId: string | null) => {
    const fact = facts.find((f) => f.id === factId);
    if (!fact || fact.status === 'supported') return;
    // An authored question supplies the wording for a gap already included in a group.
    const previous = result.find((q) => q.factIds.includes(factId));
    if (previous) {
      previous.stages = [...new Set([...previous.stages, stage])];
      return;
    }
    add({
      itemId: `fact.${factId}`, question: `请补充“${fact.proposition}”的实际情况；不清楚可直接说明。`,
      impact, severity: 'conditional', partyId, factIds: [factId], stages: [stage],
    });
  };
  for (const frame of evidence?.behaviorFrames ?? []) {
    for (const id of frame.unknownFactIds) addFact(id, 'evidence', `影响对“${frame.description}”的通行义务、过错和因果作用判断。`, frame.partyId);
  }
  if (usable('duties')) {
    for (const match of (record.stages.duties.payload as Duties).legalMatches) {
      if (match.applicability === 'not_applicable') continue;
      const name = reg?.parties.find((p) => p.id === match.partyId)?.name ?? match.partyId;
      for (const id of [...match.missingFactIds, ...match.elements.filter((e) => ['unknown', 'disputed'].includes(e.status)).flatMap((e) => e.factIds)]) {
        addFact(id, 'duties', `影响${match.legalRef.article}对${name}的适用或违反判断，须按补充事实重新核对。`, match.partyId);
      }
    }
  }
  if (usable('faults')) {
    for (const evaluation of (record.stages.faults.payload as Faults).evaluations) {
      for (const id of evaluation.pendingReviewFactIds) addFact(id, 'faults', `影响该方过错严重程度${evaluation.majorFaultCandidate ? '及重大过错候选的审查' : ''}。`, evaluation.partyId);
    }
  }
  if (usable('causation')) {
    for (const analysis of (record.stages.causation.payload as Causation).analyses) {
      if (analysis.conclusion === 'not_established') continue;
      for (const id of analysis.disputedFactIds) addFact(id, 'causation', '影响事故因果作用是否成立及责任建议，须分别核对争议事实的不同情况。', null);
    }
  }
  const priority = (q: CaseQuestion) => q.itemId === 'review.field.original.servedOn' ? 3 : q.itemId === 'review.field.priorReview' ? 2 : q.severity === 'blocking' ? 1 : 0;
  return result.sort((a, b) => priority(b) - priority(a));
}

/**
 * Return the next question batch and the replies requiring evidence review.
 * @param record persisted case
 * @returns workflow state, up to three pending questions, and unresolved/review records
 */
export function clarificationFor(record: CaseRecord, factsOnly = false) {
  const answers = latestAnswers(record);
  const pendingAnswers = answers.filter((a) => a.appliedAtRevision === null);
  const questions = collectQuestions(record).filter((q) => !factsOnly || q.target !== 'review_intake').map((q) => ({
    ...q, status: q.target === 'review_intake'
      ? (answers.find((a) => sameQuestion(a.questionRecord, q))?.status === 'unknown' ? 'unknown' : 'pending')
      : answers.find((a) => sameQuestion(a.questionRecord, q))?.status ?? 'pending',
  }));
  const pending = questions.filter((q) => q.status === 'pending');
  const unresolved = questions.filter((q) => q.status !== 'pending');
  const pendingFacts = pending.filter((q) => q.target !== 'review_intake');
  const pendingBlockingCount = pendingFacts.filter((q) => q.severity === 'blocking').length;
  const status = pendingAnswers.length || record.stages.evidence.status === 'stale'
    ? 'needs_reanalysis' : pendingBlockingCount ? 'needs_answers' : pending.length || unresolved.length ? 'limited' : 'complete';
  return {
    status,
    pendingCount: pending.length,
    pendingFactCount: pendingFacts.length,
    pendingBlockingCount,
    pendingConditionalCount: pendingFacts.length - pendingBlockingCount,
    pendingIntakeCount: pending.length - pendingFacts.length,
    questions: (status === 'needs_reanalysis' ? pending.filter((q) => q.target === 'review_intake') : pending).slice(0, 3),
    unresolved,
    pendingAnswers,
    answerHistory: record.questionAnswers ?? [],
  };
}

/**
 * Prepare the evidence update while preserving each unprocessed answer as an attributed statement.
 * @param record case with pending answers
 * @returns the prior evidence plus new statement materials and observations, or null when no review is due
 */
export function evidenceForUpdate(record: CaseRecord): EvidenceAnalysis | null {
  const pending = latestAnswers(record).filter((a) => a.appliedAtRevision === null);
  if (!pending.length && record.stages.evidence.status !== 'stale') return null;
  const evidence: EvidenceAnalysis = structuredClone(record.stages.evidence.payload as EvidenceAnalysis | null) ?? {
    skippedReason: null, materials: [], observations: [], facts: [], qualityIssues: [],
  };
  for (const answer of pending) {
    const materialId = `reply_m_${answer.id}`;
    const observationId = `reply_o_${answer.id}`;
    if (!evidence.materials.some((m) => m.id === materialId)) evidence.materials.push({
      id: materialId, title: `补充回答：${answer.questionRecord.question}`, kind: 'statement', source: `用户补充回答 ${answer.itemId}（${answer.receivedAt}）`,
    });
    if (!evidence.observations.some((o) => o.id === observationId)) evidence.observations.push({
      id: observationId, materialId, locator: answer.itemId, kind: 'statement', content: answer.answer,
      speaker: answer.speaker, partyIds: answer.questionRecord.partyId ? [answer.questionRecord.partyId] : [],
      vehicleIds: [], timeRange: null, issue: answer.questionRecord.impact,
    });
  }
  evidence.skippedReason = null;
  return evidence;
}
