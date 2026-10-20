/** Regression checks for sequential liability retries and unsupported uncertainty removal. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CaseStore, submitStage } from '../src/engine.ts';
import { loadLawLibrary } from '../src/laws.ts';
import { PayloadValidationError } from '../src/validation.ts';
import { liabilityFixture } from './liability-fixtures.ts';
import type { Causation, Liability } from '../src/schema.ts';

const directory = mkdtempSync(`${tmpdir()}/traffic-liability-regression-`);
const store = new CaseStore(directory);
const lib = loadLawLibrary(new URL('../data/laws/', import.meta.url).pathname);
const fixture = liabilityFixture(lib);
function setup() {
  const { caseId } = submitStage(store, lib, { stage: 'registration', payload: fixture.registration });
  for (const stage of ['evidence', 'duties', 'faults', 'causation'] as const) submitStage(store, lib, { caseId, stage, payload: fixture[stage] });
  return caseId;
}
function reject(caseId: string, stage: 'liability' | 'causation' | 'faults', payload: unknown, inspect: (error: PayloadValidationError) => void) {
  const before = store.get(caseId);
  assert.throws(() => submitStage(store, lib, { caseId, stage, payload }), (error: Error) => {
    assert.ok(error instanceof PayloadValidationError);
    inspect(error);
    return true;
  });
  assert.deepEqual(store.get(caseId), before, '校验拒绝不能修改案件、revision 或下游状态');
}

try {
  const caseId = setup();
  reject(caseId, 'liability', fixture.rejected, (error) => {
    assert.equal(error.issues.length, 4, '一次返回规则、分责、主情景引用与缺项问题');
    assert.ok(error.issues.every((issue) => issue.path !== '$'));
    assert.deepEqual(error.issues.find((issue) => issue.path === '$.scenarios[0].issueIds')!.missingValues, ['I1', 'CI1']);
  });
  assert.equal(submitStage(store, lib, { caseId, stage: 'liability', payload: fixture.liability }).saved, true, '集中修正后一次保存');
  const badReferences = structuredClone(fixture.liability);
  badReferences.scenarios[0]!.exclusions = [{ causalId: 'missing_cause', basis: 'supported_fact', explanation: '已排除', factIds: ['missing_fact'], issueIds: ['missing_issue'] }];
  reject(caseId, 'liability', badReferences, (error) => {
    assert.ok(error.issues.some((issue) => issue.path.endsWith('.causalId')));
    assert.ok(error.issues.some((issue) => issue.path.endsWith('.factIds')));
    assert.ok(error.issues.some((issue) => issue.path.endsWith('.issueIds')));
  });

  const uncertainId = setup();
  const uncertain = structuredClone(fixture.causation);
  uncertain.analyses[0]!.conclusion = 'undetermined';
  assert.equal(submitStage(store, lib, { caseId: uncertainId, stage: 'causation', payload: uncertain }).status, 'needs_investigation');
  reject(uncertainId, 'liability', fixture.liability, (error) => {
    assert.ok(error.issues.some((issue) => issue.path === '$.parties[0].level' && issue.relatedPaths?.includes('stages.causation.payload.analyses[0].conclusion')));
    assert.ok(error.issues.some((issue) => issue.path === '$.parties[0].causalIds'));
  });
  const unresolved: Liability = { ...fixture.liability, recommendationType: 'undetermined', primaryScenarioId: null, scenarios: [], parties: fixture.liability.parties.map((party) => ({ ...party, level: '暂无法判断', causalIds: [] })) };
  assert.equal(submitStage(store, lib, { caseId: uncertainId, stage: 'liability', payload: unresolved }).saved, true, '未知作用无需先改写上游即可结束受限分析');
  const excluded = structuredClone(uncertain);
  excluded.analyses[0]!.conclusion = 'not_established';
  excluded.analyses[0]!.contribution = { status: 'scored', score: 0, reason: '已经减速，故排除', exclusionFactIds: ['F1'], scenarioCondition: null };
  reject(uncertainId, 'causation', excluded, (error) => assert.match(error.message, /上游过错仍有待查条件/));

  const revisionId = setup();
  const required: Causation = structuredClone(fixture.causation);
  required.analyses[0]!.timingRequired = true;
  required.analyses[0]!.parameters = [{ name: '碰撞时刻', value: null, unit: 's', range: null, required: true, factIds: [] }];
  submitStage(store, lib, { caseId: revisionId, stage: 'causation', payload: required });
  reject(revisionId, 'liability', fixture.liability, (error) => assert.ok(error.issues.some((issue) => issue.relatedPaths?.includes('stages.causation.payload.analyses[0].parameters[0]'))));
  const relaxed = structuredClone(required);
  relaxed.analyses[0]!.timingRequired = false;
  relaxed.analyses[0]!.parameters[0]!.required = false;
  reject(revisionId, 'causation', relaxed, (error) => assert.ok(error.issues.some((issue) => issue.path === '$.revisionBasis' && issue.relatedPaths?.includes('$.analyses[0].parameters[0].required'))));
  relaxed.revisionBasis = { reason: '本轮仅讨论信号假设下的事故作用，不做碰撞重建；纠正此前对精确时刻的要求，信号缺项仍保留', factIds: ['F1'] };
  assert.equal(submitStage(store, lib, { caseId: revisionId, stage: 'causation', payload: relaxed }).saved, true, '有说明和已采纳事实的正常纠正仍可保存');
  const forged = structuredClone(relaxed);
  forged.revisionBasis!.factIds = ['U1'];
  reject(revisionId, 'causation', forged, (error) => assert.match(error.message, /未确认事实/));
  const cleared = structuredClone(fixture.faults);
  cleared.faults[0]!.pendingConditions = [];
  reject(revisionId, 'faults', cleared, (error) => assert.match(error.message, /revisionBasis/));

  // A genuinely resolved cause can still be excluded and support a full/no-responsibility pair.
  const knownId = setup();
  const knownEvidence = structuredClone(fixture.evidence);
  knownEvidence.observations[0]!.content = 'A车在路外划定停车位内停放，发动机关闭且无人驾驶，未占用行车道；B车驶出行车道撞上A车。';
  knownEvidence.facts.push({ id: 'F2', proposition: knownEvidence.observations[0]!.content, status: 'supported', supportingObservationIds: ['O1'], opposingObservationIds: [] });
  submitStage(store, lib, { caseId: knownId, stage: 'evidence', payload: knownEvidence });
  const knownDuties = structuredClone(fixture.duties);
  knownDuties.issues = [];
  for (const duty of knownDuties.duties) { duty.status = 'supported'; duty.factIds = ['F2']; }
  submitStage(store, lib, { caseId: knownId, stage: 'duties', payload: knownDuties });
  const knownFaults = structuredClone(fixture.faults);
  for (const fault of knownFaults.faults) { fault.pendingConditions = []; fault.factIds = ['F2']; }
  knownFaults.revisionBasis = { reason: '本例已按采纳事实修正义务判断，仅验证已解决条件的保存路径', factIds: ['F1'] };
  submitStage(store, lib, { caseId: knownId, stage: 'faults', payload: knownFaults });
  const knownCausation = structuredClone(fixture.causation);
  knownCausation.issues = [];
  knownCausation.revisionBasis = knownFaults.revisionBasis;
  for (const analysis of knownCausation.analyses) {
    analysis.conclusion = analysis.id === 'AN-A' ? 'not_established' : 'supported';
    analysis.mechanism = [{ description: 'A车停在行车道外且无人驾驶', factIds: ['F2'] }, { description: 'B驶出行车道接触停放车辆', factIds: ['F2'] }];
    analysis.disputedFactIds = [];
    analysis.counterfactual.factIds = ['F2'];
    analysis.contribution = { status: 'scored', score: analysis.id === 'AN-A' ? 0 : 3, reason: 'B驶离行车道形成接触，A车停在划定车位内且未占用行车道', exclusionFactIds: analysis.id === 'AN-A' ? ['F2'] : [], scenarioCondition: null };
  }
  submitStage(store, lib, { caseId: knownId, stage: 'causation', payload: knownCausation });
  const knownLiability: Liability = {
    ...fixture.liability, recommendationType: 'supported', primaryScenarioId: null, scenarios: [],
    exclusions: [{ causalId: 'AN-A', basis: 'supported_fact', explanation: 'A车停在行车道外划定车位内且无人驾驶，没有驶入B车轨迹', factIds: ['F2'], issueIds: [] }],
    parties: fixture.liability.parties.map((party) => ({ ...party, level: party.partyId === 'A' ? '无责' : '全责', causalIds: party.partyId === 'A' ? [] : ['AN-B'] })),
  };
  assert.equal(submitStage(store, lib, { caseId: knownId, stage: 'liability', payload: knownLiability }).saved, true);

  console.log('liability ok: aggregated corrections, precise blockers, undetermined completion, exclusions, revision basis, atomic rejection');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
