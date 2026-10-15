/** Keyless integration checks for question selection, durable replies, and evidence reanalysis. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseStore, readCase, recordAnswers, submitStage } from '../src/engine.ts';
import { loadLawLibrary } from '../src/laws.ts';
import type { Causation, Duties, EvidenceAnalysis, Liability, Registration } from '../src/schema.ts';

const lib = loadLawLibrary(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'laws'));
const directory = mkdtempSync(join(tmpdir(), 'traffic-questions-'));
const store = new CaseStore(directory);
const registration: Registration = {
  occurredAt: null, reportedAt: null, location: '某路口', jurisdiction: '北京市',
  roadType: null, intersectionType: null, trafficControl: null, casualties: null, propertyLoss: null, unknowns: [],
  parties: [{ id: 'A', name: '甲', role: 'motor_driver' }, { id: 'B', name: '乙', role: 'nonmotor_driver' }], vehicles: [],
};
const questions = [
  ['signal', '当时甲车面对的信号灯是什么颜色？', '红灯与绿灯会改变通行义务判断。'],
  ['lane', '乙的原车道是否被占用到不能通行？', '能否通行会改变借道许可及机动车减速让行义务判断。'],
  ['turn', '乙在变更方向前是否做过示意动作？', '有无示意会改变示意义务的履行判断。'],
  ['brake', '甲发现乙后采取了什么避让动作？', '避让动作会改变可避免性与因果作用判断。'],
];
const evidence: EvidenceAnalysis = {
  skippedReason: 'no_materials', materials: [], observations: [], qualityIssues: [],
  facts: questions.map(([id, question]) => ({ id, proposition: question, status: 'unknown', supportingObservationIds: [], opposingObservationIds: [] })),
  openQuestions: questions.map(([id, prompt, impact]) => ({ itemId: `item.${id}`, partyId: id === 'lane' || id === 'turn' ? 'B' : 'A', prompt, impact, factIds: [id] })),
};
const duties: Duties = {
  duties: [{ id: 'duty_A', partyId: 'A', relativePartyIds: ['B'], behavior: '甲车直行', trigger: '冲突出现', requiredAction: '观察通行情况', timeRange: '事故前', ruleIds: [lib.rules[0].id], factIds: ['signal'], status: 'conditional' }],
  relations: [], legalMatches: [], controlConflicts: [], unknowns: [],
  issues: [
    { id: 'critical_lane', kind: 'fact_gap', severity: 'blocking', question: '乙的原车道当时能否通行？', impact: '这是当前义务判断的核心缺项。', factIds: ['lane'], evidenceIds: [], affectedIds: ['duty_A'] },
    { id: 'small_detail', kind: 'detail', severity: 'supplementary', question: '车辆是什么颜色？', impact: '仅供描述', factIds: [], evidenceIds: [], affectedIds: ['duty_A'] },
    { id: 'missing_rule', kind: 'rule_gap', severity: 'blocking', question: '适用的地方条文尚未检索到', impact: '须检索规则', factIds: [], evidenceIds: [], affectedIds: ['duty_A'] },
  ],
};
const emptyDuties: Duties = { duties: [], relations: [], legalMatches: [], issues: [], controlConflicts: [], unknowns: [] };
const emptyCausation: Causation = { analyses: [], issues: [], limitations: [] };
const undetermined: Liability = {
  summary: '关键事实未明确', recommendationType: 'undetermined', primaryScenarioId: null, exclusions: [], scenarios: [],
  parties: registration.parties.map((p) => ({ partyId: p.id, level: '暂无法判断', reasoning: '待核对事实', causalIds: [], ruleIds: [], conditions: [], alternatives: [] })),
  limitations: ['关键事实仍未明确'], nextSteps: ['补充事实'],
};

function createCase(payload = evidence): string {
  const created = submitStage(store, lib, { stage: 'registration', payload: registration });
  submitStage(store, lib, { caseId: created.caseId, stage: 'evidence', payload });
  return created.caseId;
}

function finishAnalysis(caseId: string) {
  submitStage(store, lib, { caseId, stage: 'duties', payload: emptyDuties });
  submitStage(store, lib, { caseId, stage: 'faults', payload: { faults: [], evaluations: [], unknowns: [] } });
  submitStage(store, lib, { caseId, stage: 'causation', payload: emptyCausation });
}

function incorporate(caseId: string): EvidenceAnalysis {
  const view = readCase(store, lib, caseId);
  const draft = view.evidenceForUpdate!;
  assert.ok(draft);
  for (const answer of view.clarification.pendingAnswers) {
    for (const factId of answer.questionRecord.factIds) {
      const fact = draft.facts.find((f) => f.id === factId)!;
      fact.status = answer.status === 'unknown' ? 'unknown' : 'supported';
      fact.supportingObservationIds = [`reply_o_${answer.id}`];
      fact.opposingObservationIds = [];
    }
  }
  draft.openQuestions = draft.openQuestions?.filter((q) => q.factIds?.some((id) => draft.facts.find((f) => f.id === id)?.status !== 'supported'));
  return draft;
}

try {
  const caseId = createCase();
  let view = readCase(store, lib, caseId);
  assert.equal(view.clarification.status, 'limited');
  assert.equal(view.clarification.pendingCount, 4);
  assert.equal(view.clarification.questions.length, 3);

  const savedDuties = submitStage(store, lib, { caseId, stage: 'duties', payload: duties });
  assert.equal(savedDuties.clarification.pendingCount, 4, '同一事实跨阶段只问一次');
  assert.equal(savedDuties.clarification.questions[0].itemId, 'item.lane', 'blocking 问题优先');
  assert.match(savedDuties.clarification.questions[0].impact, /核心缺项/);
  assert.equal(savedDuties.status, 'needs_investigation');
  assert.equal(savedDuties.clarification.pendingBlockingCount, 1);
  assert.equal(savedDuties.clarification.pendingConditionalCount, 3);
  assert.equal(savedDuties.clarification.pendingFactCount, 4);
  assert.equal(savedDuties.clarification.pendingIntakeCount, 0);
  assert.ok(!savedDuties.clarification.questions.some((q) => q.question.includes('车辆是什么颜色') || q.question.includes('地方条文')));
  assert.match(savedDuties.note, /向用户提出/);

  const revision = store.get(caseId).revision;
  assert.throws(() => recordAnswers(store, caseId, []), /至少 1/);
  assert.throws(() => recordAnswers(store, caseId, questions.map(([id]) => ({ itemId: `item.${id}`, status: 'unknown', answer: '不清楚', speaker: '甲' }))), /最多 3/);
  assert.throws(() => recordAnswers(store, caseId, [{ itemId: 'fake', status: 'answered', answer: '绿灯', speaker: '甲' }]), /不存在/);
  assert.throws(() => recordAnswers(store, caseId, [{ itemId: 'item.signal', status: 'answered', answer: '不清楚', speaker: '甲' }]), /必须为 unknown/);
  assert.throws(() => recordAnswers(store, caseId, [
    { itemId: 'item.signal', status: 'unknown', answer: '不清楚', speaker: '甲' },
    { itemId: 'fake', status: 'unknown', answer: '不清楚', speaker: '甲' },
  ]), /不存在/);
  assert.equal(store.get(caseId).revision, revision, '批次失败不能保存部分回答');

  const unknown = { itemId: 'item.signal', status: 'unknown', answer: '不清楚', speaker: '甲' };
  const noKnowledge = recordAnswers(store, caseId, [unknown]);
  assert.equal(noKnowledge.clarification.pendingCount, 3);
  assert.equal(noKnowledge.clarification.unresolved[0].status, 'unknown');
  assert.match(noKnowledge.note, /尚未回答的问题/);
  assert.equal(store.get(caseId).stages.duties.status, 'needs_investigation', '不清楚不推翻既有分析');
  const unknownRevision = store.get(caseId).revision;
  recordAnswers(store, caseId, [unknown]);
  assert.equal(store.get(caseId).revision, unknownRevision, '同一回答重试不追加记录');

  const reply = { itemId: 'item.lane', status: 'answered', answer: '非机动车道被停放的小汽车完全堵住，无法从原车道通过。', speaker: '甲' };
  const answered = recordAnswers(store, caseId, [reply]);
  assert.equal(answered.clarification.status, 'needs_reanalysis');
  assert.equal(answered.clarification.questions.length, 0);
  assert.equal(answered.nextStage, 'evidence');
  assert.equal(store.get(caseId).stages.evidence.status, 'stale');
  assert.equal(store.get(caseId).stages.duties.status, 'stale');
  assert.equal(answered.evidenceForUpdate!.observations[0].content, reply.answer);
  assert.equal(answered.evidenceForUpdate!.observations[0].speaker, '甲', '涉及乙的事实仍保留甲为回答者');
  assert.throws(() => submitStage(store, lib, { caseId, stage: 'duties', payload: emptyDuties }), /前置阶段/);
  assert.throws(() => submitStage(store, lib, { caseId, stage: 'evidence', payload: evidence }), /须保留/);
  const droppedFact = structuredClone(answered.evidenceForUpdate!);
  droppedFact.facts = droppedFact.facts.filter((f) => f.id !== 'lane');
  droppedFact.openQuestions = droppedFact.openQuestions?.filter((q) => q.itemId !== 'item.lane');
  assert.throws(() => submitStage(store, lib, { caseId, stage: 'evidence', payload: droppedFact }), /须用于更新关联事实/);

  const updated = incorporate(caseId);
  const supportedReply = updated.observations[0];
  const forged = structuredClone(updated);
  forged.observations[0].content = '乙违法借道';
  assert.throws(() => submitStage(store, lib, { caseId, stage: 'evidence', payload: forged }), /保留原话/);
  const visual = structuredClone(updated);
  visual.materials.push({ id: 'video', kind: 'video', title: '行车记录仪', source: '用户上传' });
  assert.throws(() => submitStage(store, lib, { caseId, stage: 'evidence', payload: visual }), /影像材料.*完成对照/);
  submitStage(store, lib, { caseId, stage: 'evidence', payload: updated });
  view = readCase(new CaseStore(directory), lib, caseId);
  assert.equal(view.clarification.pendingAnswers.length, 0, '重新打开案件保留应用状态');
  assert.equal(view.adoptedFacts.find((f) => f.id === 'lane')?.adoptionBasis, 'statement_adopted');
  assert.equal(view.clarification.pendingCount, 2, '部分回答后只补问剩余事项');
  assert.ok(!view.clarification.questions.some((q) => q.itemId === 'item.signal' || q.itemId === 'item.lane'));

  finishAnalysis(caseId);
  assert.throws(() => submitStage(store, lib, { caseId, stage: 'liability', payload: { ...undetermined, recommendationType: 'conditional' } }), /主情景/);
  const preliminary = submitStage(store, lib, { caseId, stage: 'liability', payload: undetermined });
  assert.equal(preliminary.clarification.status, 'limited');
  assert.match(preliminary.note, /可先完成附条件/);
  assert.doesNotMatch(preliminary.note, /分析完成/);

  recordAnswers(store, caseId, [
    { itemId: 'item.turn', status: 'unknown', answer: '没看清，不确定有没有示意', speaker: '甲' },
    { itemId: 'item.brake', status: 'unknown', answer: '记不清', speaker: '甲' },
  ]);
  assert.equal(readCase(store, lib, caseId).clarification.status, 'limited');
  assert.throws(() => submitStage(store, lib, { caseId, stage: 'liability', payload: { ...undetermined, recommendationType: 'supported' } }), /仍然未知或存在争议/);
  const renamed = structuredClone(updated);
  renamed.openQuestions = renamed.openQuestions?.map((q) => ({ ...q, itemId: `new.${q.factIds![0]}` }));
  submitStage(store, lib, { caseId, stage: 'evidence', payload: renamed });
  assert.equal(readCase(store, lib, caseId).clarification.pendingCount, 0, '更换问题编号不能再次询问同一未知事实');

  // A correction restores the review requirement and keeps the original reply in history.
  recordAnswers(store, caseId, [{ ...reply, answer: '更正：小汽车没有完全堵住车道，旁边仍能通行。' }]);
  assert.equal(readCase(store, lib, caseId).clarification.status, 'needs_reanalysis');
  assert.equal(store.get(caseId).questionAnswers!.filter((a) => a.itemId === 'item.lane').length, 2);
  const correction = incorporate(caseId);
  submitStage(store, lib, { caseId, stage: 'evidence', payload: correction });
  assert.ok(correction.observations.some((o) => o.id === supportedReply.id), '旧回答仍可追溯');

  recordAnswers(store, caseId, [{ ...reply, status: 'unknown', answer: '撤回前面的说法，我现在不能确认原车道能否通行。' }]);
  assert.equal(readCase(store, lib, caseId).clarification.status, 'needs_reanalysis');
  const withdrawal = incorporate(caseId);
  const wrongWithdrawal = structuredClone(withdrawal);
  wrongWithdrawal.facts.find((f) => f.id === 'lane')!.status = 'supported';
  assert.throws(() => submitStage(store, lib, { caseId, stage: 'evidence', payload: wrongWithdrawal }), /更正为不清楚/);
  submitStage(store, lib, { caseId, stage: 'evidence', payload: withdrawal });
  assert.equal(readCase(store, lib, caseId).clarification.pendingCount, 0);

  const automatic = structuredClone(evidence);
  delete automatic.openQuestions;
  automatic.behaviorFrames = [{
    id: 'frame_B', partyId: 'B', relativePartyIds: ['A'], behaviorType: 'borrow_lane', description: '乙借用相邻车道',
    timeRange: '碰撞前', location: '路口', relation: 'same_direction_conflict', factIds: [], status: 'unknown',
    candidateTags: ['conditional_permission'], unknownFactIds: ['lane'],
  }];
  const autoId = createCase(automatic);
  const autoView = readCase(store, lib, autoId);
  assert.equal(autoView.clarification.pendingCount, 1, '分析引用的关键未知事实自动生成问题，普通未知字段不全部追问');
  assert.equal(autoView.clarification.questions[0].itemId, 'fact.lane');
  assert.match(autoView.clarification.questions[0].impact, /通行义务/);

  // Unanswered consequential facts allow scenarios, but not an unconditional conclusion.
  const conditionalId = createCase();
  const scenarioDuties: Duties = {
    ...emptyDuties,
    duties: registration.parties.map(p => ({ ...duties.duties[0], id: `duty_${p.id}`, partyId: p.id, relativePartyIds: registration.parties.filter(o => o.id !== p.id).map(o => o.id) })),
  };
  submitStage(store, lib, { caseId: conditionalId, stage: 'duties', payload: scenarioDuties });
  submitStage(store, lib, { caseId: conditionalId, stage: 'faults', payload: {
    faults: registration.parties.map(p => ({ id: `fault_${p.id}`, partyId: p.id, dutyId: `duty_${p.id}`, actualBehavior: '通行行为待信号核对', factIds: ['signal'], deviation: '在假设信号下未尽相应注意义务', realisticConditions: '路口通行', exceptionalCircumstances: '待核实', category: 'accident', pendingConditions: ['信号状态'] })),
    evaluations: [], unknowns: ['信号状态'],
  } });
  const scenarioCausation: Causation = { analyses: registration.parties.map(p => ({
    id: `cause_${p.id}`, faultId: `fault_${p.id}`, outcome: 'accident', conclusion: 'conditional',
    mechanism: [{ description: '若相应信号及注意义务成立，该行为可能参与形成冲突', factIds: ['signal'] }],
    timeline: { hazardAppeared: { value: null, factIds: [] }, observable: { value: null, factIds: [] }, discovered: { value: null, factIds: [] }, responseStarted: { value: null, factIds: [] } },
    timingRequired: false, timingReason: '仅讨论信号假设下的冲突形成，不据此计算避让时间',
    counterfactual: { question: '履行义务是否可能避免冲突', analysis: '在给定信号及履行义务假设下可能避免', factIds: ['signal'], assumptions: ['双方相应通行义务成立'] },
    parameters: [], jointEffects: '双方行为共同形成冲突', alternatives: ['信号或行为不同会改变建议'], sensitivity: '依赖信号状态', technicalReviewRequired: false, technicalReviewReason: null,
    disputedFactIds: ['signal'], contribution: { status: 'to_review', score: null, reason: '待核实', exclusionFactIds: [], scenarioCondition: null },
  })), issues: [], limitations: ['信号状态未明'] };
  submitStage(store, lib, { caseId: conditionalId, stage: 'causation', payload: scenarioCausation });
  const responsibilityRule = lib.rules.find(r => /责任/.test(r.applicability) && /责任/.test(r.text))!.id;
  const conditional: Liability = {
    ...undetermined, recommendationType: 'conditional', summary: '在双方相应义务及作用相当的假设下同责', primaryScenarioId: 'both',
    parties: registration.parties.map(p => ({ partyId: p.id, level: '同责', reasoning: '仅在明确假设下讨论', causalIds: [`cause_${p.id}`], ruleIds: [responsibilityRule], conditions: ['双方相应通行义务成立且作用相当'], alternatives: ['信号不同须重算'] })),
    scenarios: [{ id: 'both', condition: '假设双方相应通行义务成立且事故作用相当', issueIds: [], assignments: registration.parties.map(p => ({ partyId: p.id, level: '同责', causalIds: [`cause_${p.id}`] })), excludedCausalIds: [], exclusions: [], rationale: '仅供条件分析，不将假设当成事实' }],
    limitations: ['信号及其他通行事实仍待核对，条件不成立时不能沿用等级'],
  };
  const conditionalSaved = submitStage(store, lib, { caseId: conditionalId, stage: 'liability', payload: conditional });
  assert.equal(conditionalSaved.clarification.pendingCount, 4, '不必答完问题即可保存合法的条件建议');
  assert.equal(conditionalSaved.clarification.answerHistory.length, 0, '不得代答或自动把未答改为不清楚');
  assert.throws(() => submitStage(store, lib, { caseId: conditionalId, stage: 'liability', payload: { ...conditional, recommendationType: 'supported' } }), /待回答问题/);
  assert.throws(() => submitStage(store, lib, { caseId: conditionalId, stage: 'liability', payload: { ...conditional, limitations: [] } }), /limitations/);
  const blocking = structuredClone(scenarioCausation);
  blocking.issues = [{ id: 'core_conflict', kind: 'fact_gap', severity: 'blocking', question: '信号冲突无法建立合理情景', impact: '决定甲因果作用是否能够评价', factIds: ['signal'], evidenceIds: [], affectedIds: ['cause_A'] }];
  submitStage(store, lib, { caseId: conditionalId, stage: 'causation', payload: blocking });
  assert.equal(readCase(store, lib, conditionalId).clarification.pendingBlockingCount, 1);
  assert.throws(() => submitStage(store, lib, { caseId: conditionalId, stage: 'liability', payload: conditional }), /关键事实或法规阻断/);
  assert.equal(submitStage(store, lib, { caseId: conditionalId, stage: 'liability', payload: undetermined }).status, 'analyzed', '关键阻断仍可保存暂无法判断结果');
  recordAnswers(store, conditionalId, [{ itemId: 'item.signal', status: 'answered', answer: '甲面对红灯，乙面对绿灯', speaker: '甲' }]);
  assert.equal(readCase(store, lib, conditionalId).stages.liability.status, 'stale', '条件性结果形成后补答仍触发重分析');

  const resolvedId = createCase();
  for (const [id] of questions) {
    recordAnswers(store, resolvedId, [{ itemId: `item.${id}`, status: 'answered', answer: `用户明确补充 ${id} 的事实`, speaker: '甲' }]);
    submitStage(store, lib, { caseId: resolvedId, stage: 'evidence', payload: incorporate(resolvedId) });
  }
  assert.equal(readCase(store, lib, resolvedId).clarification.status, 'complete');
  finishAnalysis(resolvedId);
  assert.equal(submitStage(store, lib, { caseId: resolvedId, stage: 'liability', payload: undetermined }).clarification.status, 'complete');
  const noAnswerField = store.get(resolvedId);
  delete noAnswerField.questionAnswers;
  store.save(noAnswerField);
  assert.equal(readCase(store, lib, resolvedId).clarification.status, 'complete', '旧案件没有回答字段也能读取');
  console.log('questions ok: selection, partial/unknown replies, atomic validation, reanalysis, corrections, liability gate, legacy cases');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
