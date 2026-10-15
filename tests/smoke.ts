/**
 * Keyless smoke test: law identity search, full-text read, and stage validation through the engine.
 * Run from the repository root: node --import tsx traffic-liability-plugin/tests/smoke.ts
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseStore, readCase, submitStage } from '../src/engine.ts';
import { loadLawLibrary, readRules, ruleInForce, searchLaw } from '../src/laws.ts';

// Law data: an explicit override, the plugin's own data directory, then the original project's copy.
const candidates = [
  process.env.TRAFFIC_LAW_DIR,
  join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'laws'),
  '/Users/wilsonxu/NewTrafficAgent/data/laws',
].filter((dir): dir is string => !!dir);
const lawDir = candidates.find((dir) => existsSync(join(dir, 'rules.json'))) ?? candidates[0];
const lib = loadLawLibrary(lawDir);

// Identity search resolves the named law, never another law's same-numbered article.
const art70 = searchLaw(lib, { query: '道路交通安全法实施条例第七十条第二款' });
assert.equal(art70.status, 'matched', art70.notice);
const rule70 = art70.cards[0];
assert.ok(rule70, '第七十条应在法规库中');
assert.equal(rule70.lawId, 'road_traffic_safety_regulations');
assert.equal(rule70.articleNumber, 70);

const missing = searchLaw(lib, { lawId: 'road_traffic_safety_law', articleNumber: 999 });
assert.equal(missing.status, 'not_in_library');

const borrow = searchLaw(lib, { query: '非机动车 借道 机动车道' });
assert.ok(borrow.total > 0, '关键词检索应有候选');

const read = readRules(lib, [rule70.ruleId]);
assert.equal(read.rules.length, 1);
const text70 = read.rules[0].text;
const quote = text70.replace(/^第[^条]+条\s*/, '').slice(0, 12);
assert.ok(quote.length >= 6);

const art91 = searchLaw(lib, { lawId: 'road_traffic_safety_regulations', articleNumber: 91 });
assert.equal(art91.status, 'matched');
assert.equal(art91.cards[0].articleNumber, 91);

// Engine: registration creates the case; later stages require the id and the prior stage.
const store = new CaseStore(mkdtempSync(join(tmpdir(), 'traffic-liability-')));
const registration = {
  occurredAt: '2026-03-01T10:00:00+08:00',
  location: '某市某路直线路段',
  reportedAt: null,
  jurisdiction: '北京市',
  roadType: '城市道路',
  intersectionType: null,
  trafficControl: null,
  parties: [
    { id: 'A', name: '本人（机动车驾驶人）', role: 'motor_driver' },
    { id: 'B', name: '对方（电动自行车）', role: 'nonmotor_driver' },
  ],
  vehicles: [
    { id: 'vA', partyId: 'A', type: '小汽车', details: '法定类别待确认' },
    { id: 'vB', partyId: 'B', type: '电动车', details: '法定类别待确认' },
  ],
  casualties: '无人受伤',
  propertyLoss: null,
  unknowns: ['具体位置'],
};
const created = submitStage(store, lib, { stage: 'registration', payload: registration });
assert.equal(created.status, 'analyzed');
assert.equal(created.nextStage, 'evidence');
const caseId = created.caseId;

assert.throws(() => submitStage(store, lib, { caseId, stage: 'duties', payload: {} }), /请先完成前置阶段|缺少必填字段/);
assert.throws(() => submitStage(store, lib, { caseId, stage: 'evidence', payload: { facts: [] } }), /缺少必填字段/);

const evidence = {
  skippedReason: null,
  materials: [{ id: 'm_A', title: 'A 的事故描述', kind: 'statement', source: '当事人自述' }],
  observations: [
    {
      id: 'obs_1',
      materialId: 'm_A',
      locator: '第 1 段',
      kind: 'statement',
      content: 'B 骑电动车从非机动车道驶入相邻机动车道，与直行的 A 车发生碰撞',
      speaker: 'A',
      partyIds: ['A', 'B'],
      vehicleIds: ['vA', 'vB'],
      timeRange: null,
      issue: '单方陈述',
    },
  ],
  facts: [
    {
      id: 'fact_b_nonmotor',
      proposition: 'B 驾驶电动车从非机动车道驶入相邻机动车道',
      status: 'supported',
      supportingObservationIds: ['obs_1'],
      opposingObservationIds: [],
    },
    {
      id: 'fact_lane_passable',
      proposition: 'B 原车道能否完全通行',
      status: 'unknown',
      supportingObservationIds: [],
      opposingObservationIds: [],
    },
  ],
  qualityIssues: ['仅有 A 的陈述'],
  behaviorFrames: [
    {
      id: 'behavior_B_borrow',
      partyId: 'B',
      relativePartyIds: ['A'],
      behaviorType: 'borrow_adjacent_motor_lane',
      description: 'B 从非机动车道驶入相邻机动车道',
      timeRange: '碰撞前',
      location: '直线路段',
      relation: 'same_direction_conflict',
      factIds: ['fact_b_nonmotor'],
      status: 'conditional',
      candidateTags: ['conditional_permission'],
      unknownFactIds: ['fact_lane_passable'],
    },
  ],
};
assert.throws(
  () =>
    submitStage(store, lib, {
      caseId,
      stage: 'evidence',
      payload: { ...evidence, observations: [{ ...evidence.observations[0], partyIds: ['Z'] }] },
    }),
  /参与方 引用不存在：Z/,
);
assert.throws(
  () =>
    submitStage(store, lib, {
      caseId,
      stage: 'evidence',
      payload: { ...evidence, behaviorFrames: [{ ...evidence.behaviorFrames[0], description: 'B 违法抢行' }] },
    }),
  /只描述事实/,
);
assert.equal(submitStage(store, lib, { caseId, stage: 'evidence', payload: evidence }).status, 'analyzed');
const view = readCase(store, lib, caseId);
assert.equal(view.adoptedFacts.length, 1);
assert.equal(view.adoptedFacts[0].adoptionBasis, 'statement_adopted');
assert.equal(view.nextStage, 'duties');

const legalMatch = {
  id: 'match_B_70',
  behaviorId: 'behavior_B_borrow',
  partyId: 'B',
  legalRef: {
    ruleId: rule70.ruleId,
    lawId: 'road_traffic_safety_regulations',
    article: '第七十条第二款',
    quote,
    sourceUrl: rule70.sourceUrl,
  },
  normRole: 'conditional_permission',
  applicability: 'conditional',
  elements: [
    { id: 'e1', text: 'B 属于非机动车且驶入相邻机动车道', status: 'met', factIds: ['fact_b_nonmotor'] },
    { id: 'e2', text: '因非机动车道被占用无法在本车道内行驶', status: 'unknown', factIds: ['fact_lane_passable'] },
  ],
  permission: {
    status: 'conditionally_allowed',
    outcomeWhenMet: '在受阻路段借用相邻机动车道本身属于允许情形',
    scope: '不覆盖转向示意等独立义务',
  },
  breachStatus: 'undetermined',
  contraryFactIds: [],
  missingFactIds: ['fact_lane_passable'],
  reasoning: '许可条件是否成立取决于原车道能否通行',
};
const duties = {
  duties: [
    {
      id: 'duty_A_slow',
      partyId: 'A',
      relativePartyIds: ['B'],
      behavior: 'A 在机动车道直行',
      trigger: 'B 因受阻借用相邻机动车道',
      requiredAction: '减速让行',
      timeRange: 'B 借道期间',
      ruleIds: [rule70.ruleId],
      factIds: ['fact_b_nonmotor'],
      status: 'conditional',
    },
  ],
  relations: [
    {
      id: 'rel_A_yield_B',
      partyId: 'A',
      relativePartyIds: ['B'],
      relationType: 'conditional_yield',
      trigger: 'B 因受阻借用相邻机动车道',
      requiredAction: '机动车减速让行',
      ruleIds: [rule70.ruleId],
      factIds: ['fact_b_nonmotor'],
      applicability: 'conditional',
      performance: 'unknown',
      conflictsWith: [],
      issues: ['issue_lane'],
    },
  ],
  legalMatches: [legalMatch],
  issues: [
    {
      id: 'issue_lane',
      kind: 'fact_gap',
      severity: 'conditional',
      question: 'B 的原车道当时能否完全通行？',
      impact: '决定第七十条第二款的许可是否成立以及 A 是否负有减速让行义务',
      factIds: ['fact_lane_passable'],
      evidenceIds: [],
      affectedIds: ['duty_A_slow'],
      itemId: 'road.nonmotor_passable',
    },
  ],
  controlConflicts: [],
  unknowns: [],
};
assert.throws(
  () =>
    submitStage(store, lib, {
      caseId,
      stage: 'duties',
      payload: {
        ...duties,
        legalMatches: [{ ...legalMatch, legalRef: { ...legalMatch.legalRef, quote: '不得妨碍正常行驶的车辆' } }],
      },
    }),
  /原文片段/,
);
assert.throws(
  () => submitStage(store, lib, { caseId, stage: 'duties', payload: { ...duties, legalMatches: [{ ...legalMatch, breachStatus: 'supported' }] } }),
  /许可判断/,
);
const savedDuties = submitStage(store, lib, { caseId, stage: 'duties', payload: duties });
assert.equal(savedDuties.status, 'analyzed');
assert.equal(savedDuties.nextStage, 'faults');
assert.equal(savedDuties.clarification.questions.length, 1);
assert.equal(savedDuties.clarification.questions[0].itemId, 'road.nonmotor_passable');
assert.match(savedDuties.clarification.questions[0].impact, /许可是否成立/);

// Re-saving an upstream stage marks downstream results stale.
submitStage(store, lib, { caseId, stage: 'evidence', payload: evidence });
assert.equal(readCase(store, lib, caseId).stages.duties.status, 'stale');

// An unknown accident date no longer blocks: version checks are skipped and the save note says so.
assert.equal(ruleInForce(lib.byId.get(rule70.ruleId)!.rule, null, '北京市'), null);
const noDate = submitStage(store, lib, { stage: 'registration', payload: { ...registration, occurredAt: null } });
assert.equal(submitStage(store, lib, { caseId: noDate.caseId, stage: 'evidence', payload: evidence }).status, 'analyzed');
const savedNoDate = submitStage(store, lib, {
  caseId: noDate.caseId,
  stage: 'duties',
  payload: { ...duties, duties: [{ ...duties.duties[0], status: 'supported' }] },
});
assert.equal(savedNoDate.status, 'analyzed');
assert.match(savedNoDate.note, /事发日期未知/);

console.log(`smoke ok: ${lib.rules.length} rules loaded, case ${caseId}`);
