/**
 * Stage payload contracts for the six-stage analysis plus a dependency-free structural validator.
 * The specs are the model-facing field contract; the engine adds reference and consistency rules.
 */

export const stages = ['registration', 'evidence', 'duties', 'faults', 'causation', 'liability'] as const;
export type Stage = (typeof stages)[number];
export const stageLabels: Record<Stage, string> = {
  registration: '理解事故',
  evidence: '整理材料',
  duties: '通行义务',
  faults: '行为分析',
  causation: '因果分析',
  liability: '责任建议',
};

/** Structural schema node. Objects are strict: a key outside `properties` is a violation. */
export type Spec =
  | { type: 'string'; enum?: readonly string[]; minLength?: number; maxLength?: number; pattern?: RegExp; description?: string }
  | { type: 'number' | 'integer'; min?: number; max?: number; description?: string }
  | { type: 'boolean'; description?: string }
  | { type: 'null' }
  | { type: 'array'; items: Spec; minItems?: number; maxItems?: number; description?: string }
  | { type: 'object'; properties: Record<string, Spec & { required?: true }>; description?: string }
  | { oneOf: readonly Spec[]; description?: string };

/**
 * Validate a value against a spec.
 * @param spec structural schema
 * @param value candidate value
 * @param path display path used in violations
 * @returns path-qualified violations in Chinese; empty means valid
 */
export function validate(spec: Spec, value: unknown, path = '$'): string[] {
  if ('oneOf' in spec) {
    const attempts = spec.oneOf.map((branch) => ({ branch, violations: validate(branch, value, path) }));
    if (attempts.some((a) => a.violations.length === 0)) return [];
    // Prefer the branch whose top-level type matches the value: a nullable object missing fields
    // would otherwise lose to `null`'s single "必须是 null" violation and hide the real problem.
    const typed = attempts.filter((a) => typeMatches(a.branch, value));
    const pool = typed.length > 0 ? typed : attempts;
    const best = pool.slice().sort((a, b) => a.violations.length - b.violations.length)[0];
    if (!best) return [`${path} 不符合任一允许的形式`];
    const allowsNull = attempts.some((a) => 'type' in a.branch && a.branch.type === 'null');
    const bestIsNull = 'type' in best.branch && best.branch.type === 'null';
    return allowsNull && !bestIsNull ? [...best.violations, `${path} 也可以为 null`] : best.violations;
  }
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') return [`${path} 必须是字符串`];
      if (spec.enum && !spec.enum.includes(value)) return [`${path} 必须是 ${spec.enum.join('、')} 之一，收到 ${JSON.stringify(value)}`];
      if (spec.minLength !== undefined && value.trim().length < spec.minLength) return [`${path} 不能为空`];
      if (spec.maxLength !== undefined && value.length > spec.maxLength) return [`${path} 超过 ${spec.maxLength} 字符`];
      if (spec.pattern && !spec.pattern.test(value)) return [`${path} 格式不合法：${JSON.stringify(value)}`];
      return [];
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path} 必须是数字`];
      if (spec.type === 'integer' && !Number.isInteger(value)) return [`${path} 必须是整数`];
      if (spec.min !== undefined && value < spec.min) return [`${path} 不能小于 ${spec.min}`];
      if (spec.max !== undefined && value > spec.max) return [`${path} 不能大于 ${spec.max}`];
      return [];
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} 必须是布尔值`];
    case 'null':
      return value === null ? [] : [`${path} 必须是 null`];
    case 'array': {
      if (!Array.isArray(value)) return [`${path} 必须是数组`];
      if (spec.minItems !== undefined && value.length < spec.minItems) return [`${path} 至少 ${spec.minItems} 项`];
      if (spec.maxItems !== undefined && value.length > spec.maxItems) return [`${path} 最多 ${spec.maxItems} 项`];
      return value.flatMap((item, i) => validate(spec.items, item, `${path}[${i}]`));
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path} 必须是对象`];
      const record = value as Record<string, unknown>;
      const violations: string[] = [];
      for (const [key, property] of Object.entries(spec.properties)) {
        if (!(key in record)) {
          if (property.required) violations.push(`${path}.${key} 缺少必填字段`);
          continue;
        }
        violations.push(...validate(property, record[key], `${path}.${key}`));
      }
      for (const key of Object.keys(record)) if (!(key in spec.properties)) violations.push(`${path}.${key} 不是允许的字段`);
      return violations;
    }
  }
}

/** Whether a spec's top-level type matches the candidate, ignoring oneOf alternatives. */
function typeMatches(spec: Spec, value: unknown): boolean {
  if ('oneOf' in spec) return spec.oneOf.some((branch) => typeMatches(branch, value));
  switch (spec.type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number';
    case 'boolean':
      return typeof value === 'boolean';
  }
}

/**
 * Render a spec as a compact field outline: `key?: type`, `a | b` enums, `type | null` nullable,
 * `type[]` arrays. Kept small because every `traffic_case_read` carries all six stages.
 */
export function describeSpec(spec: Spec): string {
  const render = (s: Spec): string => {
    if ('oneOf' in s) {
      const parts = s.oneOf.map(render);
      return parts.includes('null') ? `${parts.filter((p) => p !== 'null').join(' | ')} | null` : parts.join(' | ');
    }
    switch (s.type) {
      case 'string':
        return s.enum ? s.enum.map((value) => JSON.stringify(value)).join(' | ') : 'string';
      case 'number':
      case 'integer':
        return s.type;
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'array':
        return `${render(s.items)}[]`;
      case 'object':
        return `{${Object.entries(s.properties)
          .map(([key, value]) => `${key}${value.required ? '' : '?'}: ${render(value)}`)
          .join(', ')}}`;
    }
  };
  return render(spec);
}

const id: Spec = { type: 'string', pattern: /^[A-Za-z0-9_-]{1,80}$/ };
const itemId: Spec = { type: 'string', pattern: /^[A-Za-z0-9_.:-]{1,120}$/ };
const text: Spec = { type: 'string', minLength: 1, maxLength: 20000 };
const nullable = (s: Spec): Spec => ({ oneOf: [s, { type: 'null' }] });
const refs: Spec = { type: 'array', items: id, maxItems: 200 };
const texts: Spec = { type: 'array', items: text, maxItems: 100 };
const req = (s: Spec): Spec & { required: true } => ({ ...s, required: true });
const en = (...values: string[]): Spec => ({ type: 'string', enum: values });
const obj = (properties: Record<string, Spec & { required?: true }>): Spec => ({ type: 'object', properties });
const arr = (items: Spec, maxItems?: number, minItems?: number): Spec => ({ type: 'array', items, maxItems, minItems });

export const partyRoles = ['motor_driver', 'nonmotor_driver', 'pedestrian', 'passenger', 'other'] as const;
export const registrationSpec: Spec = obj({
  occurredAt: req(nullable(text)),
  location: req(text),
  reportedAt: req(nullable(text)),
  jurisdiction: req(text),
  roadType: req(nullable(text)),
  intersectionType: req(nullable(text)),
  trafficControl: req(nullable(text)),
  parties: req(arr(obj({ id: req(id), name: req(text), role: req(en(...partyRoles)) }), 100, 1)),
  vehicles: req(arr(obj({ id: req(id), partyId: req(id), type: req(text), details: req(text) }), 100)),
  casualties: req(nullable(text)),
  propertyLoss: req(nullable(text)),
  unknowns: req(texts),
});

export const materialKinds = ['material', 'statement', 'appraisal', 'medical', 'photo', 'video'] as const;
export const behaviorRelations = ['same_direction_conflict', 'crossing_conflict', 'opposite_conflict', 'adjacent_parking', 'pedestrian_crossing', 'no_conflict', 'other'] as const;
export const candidateTags = ['right_of_way', 'yield_duty', 'conditional_permission', 'signal_control', 'lane_use', 'speed', 'signaling', 'parking', 'warning', 'observation', 'distance', 'other'] as const;
const behaviorFrameSpec = obj({
  id: req(id),
  partyId: req(id),
  relativePartyIds: req(refs),
  behaviorType: req({ type: 'string', pattern: /^[a-z][a-z0-9_]{1,60}$/ }),
  description: req(text),
  timeRange: req(text),
  location: req(text),
  relation: req(en(...behaviorRelations)),
  factIds: req(refs),
  status: req(en('supported', 'conditional', 'unknown')),
  candidateTags: req(arr(en(...candidateTags), 12)),
  unknownFactIds: req(refs),
  relatedBehaviorIds: refs,
});
export const evidenceSpec: Spec = obj({
  skippedReason: req(nullable(en('no_materials', 'pending_appraisal'))),
  materials: req(arr(obj({ id: req(id), title: req(text), kind: req(en(...materialKinds)), source: req(text) }), 100)),
  observations: req(
    arr(
      obj({
        id: req(id),
        materialId: req(id),
        locator: req(text),
        kind: req(en('observation', 'statement')),
        content: req(text),
        speaker: req(nullable(text)),
        partyIds: req(refs),
        vehicleIds: req(refs),
        timeRange: req(nullable(text)),
        issue: req(text),
      }),
    ),
  ),
  facts: req(
    arr(
      obj({
        id: req(id),
        proposition: req(text),
        status: req(en('supported', 'disputed', 'unknown')),
        supportingObservationIds: req(refs),
        opposingObservationIds: req(refs),
        adoptionBasis: nullable(en('observation', 'statement_adopted')),
        visualChecks: arr(
          obj({
            materialId: req(id),
            result: req(en('no_conflict', 'conflict', 'unclear', 'not_relevant')),
            observationIds: req(refs),
            reason: req(text),
          }),
          200,
        ),
      }),
    ),
  ),
  qualityIssues: req(texts),
  behaviorFrames: arr(behaviorFrameSpec, 60),
  openQuestions: arr(
    obj({ itemId: req(itemId), partyId: req(nullable(id)), prompt: req(text), impact: req(text), factIds: arr(id, 200, 1) }),
    8,
  ),
});

export const issueKinds = ['fact_gap', 'evidence_conflict', 'rule_gap', 'detail'] as const;
export const severities = ['blocking', 'conditional', 'supplementary'] as const;
/** User replies preserve their wording and speaker; an unknown reply supplies no factual conclusion. */
export const answerBatchSpec: Spec = arr(
  obj({ itemId: req(itemId), status: req(en('answered', 'unknown')), answer: req(text), speaker: req(text) }),
  3,
  1,
);
export interface QuestionReply {
  itemId: string;
  status: 'answered' | 'unknown';
  answer: string;
  speaker: string;
}
const issueSpec = obj({
  id: req(id),
  kind: req(en(...issueKinds)),
  severity: req(en(...severities)),
  question: req(text),
  impact: req(text),
  factIds: req(refs),
  evidenceIds: req(refs),
  affectedIds: req(arr(id, 200, 1)),
  itemId,
});
export const normRoles = ['behavior_rule', 'prohibition', 'conditional_permission', 'liability_rule', 'procedure_rule'] as const;
export const applicabilityStatuses = ['applicable', 'conditional', 'not_applicable', 'unassessed'] as const;
export const breachStatuses = ['supported', 'conditional', 'not_established', 'undetermined'] as const;
export const elementStatuses = ['met', 'not_met', 'unknown', 'disputed'] as const;
export const permissionStatuses = ['satisfied', 'conditionally_allowed', 'not_applicable'] as const;
const legalMatchSpec = obj({
  id: req(id),
  behaviorId: req(id),
  partyId: req(id),
  legalRef: req(
    obj({
      ruleId: req(id),
      lawId: req({ type: 'string', pattern: /^[a-z][a-z0-9_]{1,60}$/ }),
      article: req(text),
      quote: req(text),
      sourceUrl: req(text),
      sourceTextHash: { type: 'string', pattern: /^[a-f0-9]{64}$/ },
    }),
  ),
  normRole: req(en(...normRoles)),
  applicability: req(en(...applicabilityStatuses)),
  elements: req(arr(obj({ id: req(id), text: req(text), status: req(en(...elementStatuses)), factIds: req(refs) }), 12)),
  permission: req(nullable(obj({ status: req(en(...permissionStatuses)), outcomeWhenMet: req(text), scope: req(text) }))),
  breachStatus: req(en(...breachStatuses)),
  contraryFactIds: req(refs),
  missingFactIds: req(refs),
  reasoning: req(text),
});
export const relationTypes = ['yield', 'conditional_yield', 'priority', 'mutual_care', 'no_relation'] as const;
export const performanceStatuses = ['performed', 'not_performed', 'unknown', 'not_applicable'] as const;
const relationSpec = obj({
  id: req(id),
  partyId: req(id),
  relativePartyIds: req(arr(id, 200, 1)),
  relationType: req(en(...relationTypes)),
  trigger: req(text),
  requiredAction: req(text),
  timeRange: text,
  ruleIds: req(arr(id, 200, 1)),
  factIds: req(refs),
  applicability: req(en(...applicabilityStatuses)),
  performance: req(en(...performanceStatuses)),
  conflictsWith: req(refs),
  issues: req(refs),
});
export const dutiesSpec: Spec = obj({
  duties: req(
    arr(
      obj({
        id: req(id),
        partyId: req(id),
        relativePartyIds: req(refs),
        behavior: req(text),
        trigger: req(text),
        requiredAction: req(text),
        timeRange: req(text),
        ruleIds: req(arr(id, 200, 1)),
        factIds: req(arr(id, 200, 1)),
        status: req(en('conditional', 'supported')),
      }),
    ),
  ),
  relations: req(arr(relationSpec)),
  legalMatches: req(arr(legalMatchSpec, 80)),
  issues: req(arr(issueSpec, 20)),
  controlConflicts: req(texts),
  unknowns: req(texts),
});

export const scoreStatuses = ['scored', 'to_review', 'not_applicable'] as const;
export const faultCategories = ['accident', 'damage', 'independent', 'insufficient'] as const;
export const faultsSpec: Spec = obj({
  faults: req(
    arr(
      obj({
        id: req(id),
        partyId: req(id),
        dutyId: req(id),
        actualBehavior: req(text),
        factIds: req(arr(id, 200, 1)),
        deviation: req(text),
        realisticConditions: req(text),
        exceptionalCircumstances: req(text),
        category: req(en(...faultCategories)),
        pendingConditions: req(texts),
      }),
    ),
  ),
  evaluations: req(
    arr(
      obj({
        id: req(id),
        faultId: req(id),
        partyId: req(id),
        legalMatchIds: req(refs),
        seriousness: req(obj({ status: req(en(...scoreStatuses)), score: req(nullable({ type: 'integer', min: 1, max: 3 })), reason: req(text) })),
        majorFaultCandidate: req({ type: 'boolean' }),
        majorFaultReason: req(nullable(text)),
        pendingReviewFactIds: req(refs),
        scenarioCondition: req(nullable(text)),
        reasoning: req(text),
      }),
      60,
    ),
  ),
  unknowns: req(texts),
});

const moment = obj({ value: req(nullable(text)), factIds: req(refs) });
export const causationSpec: Spec = obj({
  analyses: req(
    arr(
      obj({
        id: req(id),
        faultId: req(id),
        outcome: req(en('accident', 'damage')),
        conclusion: req(en('supported', 'conditional', 'not_established')),
        mechanism: req(arr(obj({ description: req(text), factIds: req(arr(id, 200, 1)) }), 100, 1)),
        timeline: req(obj({ hazardAppeared: req(moment), observable: req(moment), discovered: req(moment), responseStarted: req(moment) })),
        timingRequired: { type: 'boolean' },
        timingReason: text,
        counterfactual: req(obj({ question: req(text), analysis: req(text), factIds: req(refs), assumptions: req(texts) })),
        parameters: req(
          arr(
            obj({
              name: req(text),
              value: req(nullable({ type: 'number' })),
              unit: req(text),
              range: req(nullable(arr({ type: 'number' }, 2, 2))),
              factIds: req(refs),
              required: req({ type: 'boolean' }),
            }),
          ),
        ),
        jointEffects: req(text),
        alternatives: req(arr(text, 100, 1)),
        sensitivity: req(text),
        technicalReviewRequired: req({ type: 'boolean' }),
        technicalReviewReason: req(nullable(text)),
        disputedFactIds: req(refs),
        contribution: req(
          obj({
            status: req(en(...scoreStatuses)),
            score: req(nullable({ type: 'integer', min: 0, max: 3 })),
            reason: req(text),
            exclusionFactIds: req(refs),
            scenarioCondition: req(nullable(text)),
          }),
        ),
      }),
    ),
  ),
  issues: req(arr(issueSpec, 20)),
  limitations: req(texts),
});

export const responsibilityLevels = ['全责', '主责', '同责', '次责', '无责', '暂无法判断'] as const;
const exclusionSpec = obj({
  causalId: req(id),
  basis: req(en('supported_fact', 'scenario_assumption')),
  explanation: req(text),
  factIds: req(refs),
  issueIds: req(refs),
});
export const liabilitySpec: Spec = obj({
  summary: req(text),
  recommendationType: req(en('supported', 'conditional', 'undetermined')),
  primaryScenarioId: req(nullable(id)),
  exclusions: req(arr(exclusionSpec, 50)),
  scenarios: req(
    arr(
      obj({
        id: req(id),
        condition: req(text),
        issueIds: req(refs),
        assignments: req(arr(obj({ partyId: req(id), level: req(en(...responsibilityLevels)), causalIds: req(refs) }), 100, 1)),
        excludedCausalIds: req(refs),
        exclusions: req(arr(exclusionSpec, 50)),
        rationale: req(text),
      }),
      4,
    ),
  ),
  parties: req(
    arr(
      obj({
        partyId: req(id),
        level: req(en(...responsibilityLevels)),
        reasoning: req(text),
        causalIds: req(refs),
        ruleIds: req(refs),
        conditions: req(texts),
        alternatives: req(texts),
      }),
    ),
  ),
  limitations: req(texts),
  nextSteps: req(texts),
});

export const stageSpecs: Record<Stage, Spec> = {
  registration: registrationSpec,
  evidence: evidenceSpec,
  duties: dutiesSpec,
  faults: faultsSpec,
  causation: causationSpec,
  liability: liabilitySpec,
};

/**
 * Required top-level field names of a stage payload, for the model-facing contract summary.
 * @param stage stage name
 * @returns the required keys in declaration order
 */
export function requiredFields(stage: Stage): string[] {
  const spec = stageSpecs[stage];
  if (!('type' in spec) || spec.type !== 'object') return [];
  return Object.entries(spec.properties)
    .filter(([, s]) => s.required)
    .map(([k]) => k);
}

export interface Registration {
  occurredAt: string | null;
  location: string;
  reportedAt: string | null;
  jurisdiction: string;
  roadType: string | null;
  intersectionType: string | null;
  trafficControl: string | null;
  parties: { id: string; name: string; role: (typeof partyRoles)[number] }[];
  vehicles: { id: string; partyId: string; type: string; details: string }[];
  casualties: string | null;
  propertyLoss: string | null;
  unknowns: string[];
}
export interface Material {
  id: string;
  title: string;
  kind: (typeof materialKinds)[number];
  source: string;
}
export interface Observation {
  id: string;
  materialId: string;
  locator: string;
  kind: 'observation' | 'statement';
  content: string;
  speaker: string | null;
  partyIds: string[];
  vehicleIds: string[];
  timeRange: string | null;
  issue: string;
}
export interface VisualCheck {
  materialId: string;
  result: 'no_conflict' | 'conflict' | 'unclear' | 'not_relevant';
  observationIds: string[];
  reason: string;
}
export interface Fact {
  id: string;
  proposition: string;
  status: 'supported' | 'disputed' | 'unknown';
  supportingObservationIds: string[];
  opposingObservationIds: string[];
  adoptionBasis?: 'observation' | 'statement_adopted' | null;
  visualChecks?: VisualCheck[];
}
export interface BehaviorFrame {
  id: string;
  partyId: string;
  relativePartyIds: string[];
  behaviorType: string;
  description: string;
  timeRange: string;
  location: string;
  relation: (typeof behaviorRelations)[number];
  factIds: string[];
  status: 'supported' | 'conditional' | 'unknown';
  candidateTags: (typeof candidateTags)[number][];
  unknownFactIds: string[];
  relatedBehaviorIds?: string[];
}
export interface EvidenceAnalysis {
  skippedReason: 'no_materials' | 'pending_appraisal' | null;
  materials: Material[];
  observations: Observation[];
  facts: Fact[];
  qualityIssues: string[];
  behaviorFrames?: BehaviorFrame[];
  openQuestions?: { itemId: string; partyId: string | null; prompt: string; impact: string; factIds?: string[] }[];
}
export interface AnalysisIssue {
  id: string;
  kind: (typeof issueKinds)[number];
  severity: (typeof severities)[number];
  question: string;
  impact: string;
  factIds: string[];
  evidenceIds: string[];
  affectedIds: string[];
  itemId?: string;
}
export interface LegalMatch {
  id: string;
  behaviorId: string;
  partyId: string;
  legalRef: { ruleId: string; lawId: string; article: string; quote: string; sourceUrl: string; sourceTextHash?: string };
  normRole: (typeof normRoles)[number];
  applicability: (typeof applicabilityStatuses)[number];
  elements: { id: string; text: string; status: (typeof elementStatuses)[number]; factIds: string[] }[];
  permission: { status: (typeof permissionStatuses)[number]; outcomeWhenMet: string; scope: string } | null;
  breachStatus: (typeof breachStatuses)[number];
  contraryFactIds: string[];
  missingFactIds: string[];
  reasoning: string;
}
export interface DutyRelation {
  id: string;
  partyId: string;
  relativePartyIds: string[];
  relationType: (typeof relationTypes)[number];
  trigger: string;
  requiredAction: string;
  timeRange?: string;
  ruleIds: string[];
  factIds: string[];
  applicability: (typeof applicabilityStatuses)[number];
  performance: (typeof performanceStatuses)[number];
  conflictsWith: string[];
  issues: string[];
}
export interface Duty {
  id: string;
  partyId: string;
  relativePartyIds: string[];
  behavior: string;
  trigger: string;
  requiredAction: string;
  timeRange: string;
  ruleIds: string[];
  factIds: string[];
  status: 'conditional' | 'supported';
}
export interface Duties {
  duties: Duty[];
  relations: DutyRelation[];
  legalMatches: LegalMatch[];
  issues: AnalysisIssue[];
  controlConflicts: string[];
  unknowns: string[];
}
export interface Fault {
  id: string;
  partyId: string;
  dutyId: string;
  actualBehavior: string;
  factIds: string[];
  deviation: string;
  realisticConditions: string;
  exceptionalCircumstances: string;
  category: (typeof faultCategories)[number];
  pendingConditions: string[];
}
export interface FaultEvaluation {
  id: string;
  faultId: string;
  partyId: string;
  legalMatchIds: string[];
  seriousness: { status: (typeof scoreStatuses)[number]; score: number | null; reason: string };
  majorFaultCandidate: boolean;
  majorFaultReason: string | null;
  pendingReviewFactIds: string[];
  scenarioCondition: string | null;
  reasoning: string;
}
export interface Faults {
  faults: Fault[];
  evaluations: FaultEvaluation[];
  unknowns: string[];
}
export interface Moment {
  value: string | null;
  factIds: string[];
}
export interface CausalAnalysis {
  id: string;
  faultId: string;
  outcome: 'accident' | 'damage';
  conclusion: 'supported' | 'conditional' | 'not_established';
  mechanism: { description: string; factIds: string[] }[];
  timeline: { hazardAppeared: Moment; observable: Moment; discovered: Moment; responseStarted: Moment };
  timingRequired?: boolean;
  timingReason?: string;
  counterfactual: { question: string; analysis: string; factIds: string[]; assumptions: string[] };
  parameters: { name: string; value: number | null; unit: string; range: number[] | null; factIds: string[]; required: boolean }[];
  jointEffects: string;
  alternatives: string[];
  sensitivity: string;
  technicalReviewRequired: boolean;
  technicalReviewReason: string | null;
  disputedFactIds: string[];
  contribution: { status: (typeof scoreStatuses)[number]; score: number | null; reason: string; exclusionFactIds: string[]; scenarioCondition: string | null };
}
export interface Causation {
  analyses: CausalAnalysis[];
  issues: AnalysisIssue[];
  limitations: string[];
}
export interface CausalExclusion {
  causalId: string;
  basis: 'supported_fact' | 'scenario_assumption';
  explanation: string;
  factIds: string[];
  issueIds: string[];
}
export type ResponsibilityLevel = (typeof responsibilityLevels)[number];
export interface Scenario {
  id: string;
  condition: string;
  issueIds: string[];
  assignments: { partyId: string; level: ResponsibilityLevel; causalIds: string[] }[];
  excludedCausalIds: string[];
  exclusions: CausalExclusion[];
  rationale: string;
}
export interface Liability {
  summary: string;
  recommendationType: 'supported' | 'conditional' | 'undetermined';
  primaryScenarioId: string | null;
  exclusions: CausalExclusion[];
  scenarios: Scenario[];
  parties: { partyId: string; level: ResponsibilityLevel; reasoning: string; causalIds: string[]; ruleIds: string[]; conditions: string[]; alternatives: string[] }[];
  limitations: string[];
  nextSteps: string[];
}
export type Payload = Registration | EvidenceAnalysis | Duties | Faults | Causation | Liability;
