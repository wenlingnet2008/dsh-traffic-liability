/** Two conditional causes for exercising responsibility corrections without a model request. */
import type { LawLibrary } from '../src/laws.ts';
import type { Causation, Duties, EvidenceAnalysis, Faults, Liability, Registration } from '../src/schema.ts';

export function liabilityFixture(lib: LawLibrary) {
  const responsibilityRule = lib.entries.find((entry) => entry.lawId === 'road_traffic_safety_regulations' && entry.articleNumber === 91)!.rule.id;
  const drivingRule = lib.entries.find((entry) => entry.lawId === 'road_traffic_safety_law' && entry.articleNumber === 22)!.rule.id;
  const registration: Registration = {
    occurredAt: null, reportedAt: null, location: '路口', jurisdiction: '北京市', roadType: null,
    intersectionType: null, trafficControl: null, casualties: null, propertyLoss: null, unknowns: [],
    parties: ['A', 'B'].map((id) => ({ id, name: id, role: 'motor_driver' })), vehicles: [],
  };
  const evidence: EvidenceAnalysis = {
    skippedReason: null, materials: [{ id: 'M1', kind: 'statement', title: '事故陈述', source: '用户' }],
    observations: [{ id: 'O1', materialId: 'M1', kind: 'statement', content: '两车在路口发生碰撞。', speaker: 'A', locator: '原话', partyIds: ['A', 'B'], vehicleIds: [], timeRange: null, issue: '用户陈述' }],
    facts: [
      { id: 'F1', proposition: '两车在路口发生碰撞', status: 'supported', supportingObservationIds: ['O1'], opposingObservationIds: [] },
      { id: 'U1', proposition: '双方通行信号', status: 'unknown', supportingObservationIds: [], opposingObservationIds: [] },
    ], qualityIssues: [],
  };
  const duties: Duties = {
    duties: ['A', 'B'].map((partyId) => ({ id: `D-${partyId}`, partyId, relativePartyIds: [], behavior: '驶入路口', trigger: '相应信号下的通行冲突', requiredAction: '遵守信号并安全通行', timeRange: '事故前', ruleIds: [drivingRule], factIds: ['U1'], status: 'conditional' })),
    legalMatches: [], relations: [], controlConflicts: [], unknowns: [],
    issues: [{ id: 'I1', kind: 'fact_gap', severity: 'conditional', question: 'B的通行信号？', impact: '改变B的通行义务和事故作用', factIds: ['U1'], evidenceIds: [], affectedIds: ['D-B'] }],
  };
  const faults: Faults = {
    faults: ['A', 'B'].map((partyId) => ({ id: `FT-${partyId}`, partyId, dutyId: `D-${partyId}`, actualBehavior: '驶入路口', factIds: ['F1'], deviation: '若对应禁止信号成立则违反通行要求', realisticConditions: '路口', exceptionalCircumstances: '无已知例外', category: 'accident', pendingConditions: ['信号待查'] })),
    evaluations: [], unknowns: ['信号待查'],
  };
  const causation: Causation = {
    analyses: ['A', 'B'].map((partyId) => ({
      id: `AN-${partyId}`, faultId: `FT-${partyId}`, outcome: 'accident', conclusion: 'conditional',
      mechanism: [{ description: '在相应通行义务假设下形成冲突', factIds: ['F1', 'U1'] }],
      timeline: { hazardAppeared: { value: null, factIds: [] }, observable: { value: null, factIds: [] }, discovered: { value: null, factIds: [] }, responseStarted: { value: null, factIds: [] } },
      timingRequired: false, timingReason: '仅讨论信号假设，不计算避让时间',
      counterfactual: { question: '遵守相应信号能否避免冲突？', analysis: '在相应信号及通行义务成立的假设下可能避免', factIds: ['U1'], assumptions: ['对应义务成立'] },
      parameters: [], jointEffects: '作用大小依赖信号', alternatives: ['信号不同需要重做分析'], sensitivity: '信号改变义务和事故作用', technicalReviewRequired: false, technicalReviewReason: null,
      disputedFactIds: ['U1'], contribution: { status: 'to_review', score: null, reason: '待核对', exclusionFactIds: [], scenarioCondition: null },
    })),
    issues: [{ id: 'CI1', kind: 'fact_gap', severity: 'conditional', question: 'A的通行信号？', impact: '改变A的事故作用', factIds: ['U1'], evidenceIds: [], affectedIds: ['AN-A'] }], limitations: ['信号未知'],
  };
  const liability: Liability = {
    summary: '仅在双方相应义务及事故作用相当的假设下同责', recommendationType: 'conditional', primaryScenarioId: 'S1', exclusions: [],
    scenarios: [{ id: 'S1', condition: '双方相应通行义务成立且事故作用相当', issueIds: ['I1', 'CI1'], assignments: ['A', 'B'].map((partyId) => ({ partyId, level: '同责', causalIds: [`AN-${partyId}`] })), excludedCausalIds: [], exclusions: [], rationale: '只在假设下评价，不将其当成已查明事实' }],
    parties: ['A', 'B'].map((partyId) => ({ partyId, level: '同责', reasoning: '仅讨论给定假设', causalIds: [`AN-${partyId}`], ruleIds: [responsibilityRule], conditions: ['相应通行义务成立且作用相当'], alternatives: ['信号不同须重算'] })),
    limitations: ['信号未知，条件不成立不得沿用等级'], nextSteps: ['补充信号事实'],
  };
  const rejected = structuredClone(liability);
  rejected.parties[0]!.ruleIds = [drivingRule];
  rejected.scenarios[0]!.issueIds = [];
  rejected.scenarios[0]!.excludedCausalIds = ['AN-A'];
  rejected.scenarios[0]!.exclusions = [{ causalId: 'AN-A', basis: 'scenario_assumption', explanation: '另假设A依信号通行', factIds: [], issueIds: ['CI1'] }];
  return { registration, evidence, duties, faults, causation, liability, rejected };
}
