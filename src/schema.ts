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
 * Render a strict object outline with optional keys, unions, arrays, and validation constraints.
 * @param spec structural schema to describe
 * @returns compact field types with string, numeric, array, and regular-expression limits
 */
export function describeSpec(spec: Spec): string {
  const constrained = (type: string, limits: [string, number | string | undefined][]): string => {
    const defined = limits.filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`);
    return defined.length ? `${type}[${defined.join(',')}]` : type;
  };
  const render = (s: Spec): string => {
    if ('oneOf' in s) {
      const parts = s.oneOf.map(render);
      return parts.includes('null') ? `${parts.filter((p) => p !== 'null').join(' | ')} | null` : parts.join(' | ');
    }
    switch (s.type) {
      case 'string':
        return constrained(s.enum ? s.enum.map((value) => JSON.stringify(value)).join(' | ') : 'string', [
          ['minLength', s.minLength], ['maxLength', s.maxLength], ['pattern', s.pattern?.toString()],
        ]);
      case 'number':
      case 'integer':
        return constrained(s.type, [['min', s.min], ['max', s.max]]);
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'array': {
        const item = render(s.items);
        const isUnion = 'oneOf' in s.items || (s.items.type === 'string' && !!s.items.enum);
        return constrained(`${isUnion ? `(${item})` : item}[]`, [['minItems', s.minItems], ['maxItems', s.maxItems]]);
      }
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
const revisionBasisSpec = obj({ reason: req(text), factIds: req(arr(id, 200, 1)) });
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
  revisionBasis: revisionBasisSpec,
});

const moment = obj({ value: req(nullable(text)), factIds: req(refs) });
export const causationSpec: Spec = obj({
  analyses: req(
    arr(
      obj({
        id: req(id),
        faultId: req(id),
        outcome: req(en('accident', 'damage')),
        conclusion: req(en('supported', 'conditional', 'not_established', 'undetermined')),
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
  revisionBasis: revisionBasisSpec,
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

/** Summary of a stage's payload; detailed schemas are included only when requested. */
export interface StageContract {
  label: string;
  requiredFields: string[];
  schema?: string;
  notes?: string;
  rules?: readonly string[];
}

const stageRules: Record<Stage, readonly string[]> = {
  registration: [
    'parties、vehicles 的 ID 各自唯一；vehicles[].partyId 引用 parties[].id。',
    'occurredAt、reportedAt 须可解析，未知用 null；地点和管辖不明时写待补充并列入 unknowns，不编造日期或身份。',
  ],
  evidence: [
    '用户对视频、照片的文字转述属于 statement：materials[].kind 与 observations[].kind 均为 statement，保留 speaker。只有实际读取原始影像才能登记 video/photo 和客观 observation；未取得原件时不得写已核验视频。',
    'supported 事实必须引用 supportingObservationIds 且无反驳记录；陈述可采纳，程序计算 adoptionBasis，不把 statement_adopted 改称客观观察。',
    'visualChecks 引用实际影像及同一材料的 observations；no_conflict、conflict、not_relevant 均要求非空 observationIds，无法读取或尚未对照用 unclear，冲突用 disputed。',
    '有影像时，依赖陈述的 supported 事实须逐项完成 no_conflict 或 not_relevant 对照；未知事实不能靠猜测补成确定事实。',
    'behaviorFrames 只描述中性行为；supported 引用已采纳事实，conditional 列出未知或争议事实；unknownFactIds 和 openQuestions 不得引用 supported 事实。',
  ],
  duties: [
    'duties 的参与方、事实、法条 ID 必须存在；status=supported 仅引用已采纳事实。legalMatches[].behaviorId 引用 evidence.behaviorFrames[].id。',
    'elements[].status 为 met/not_met 时 factIds 非空且全部为 supported；unknown 时非空且全部为 unknown/disputed；disputed 至少引用一条 disputed 事实。',
    'applicability=applicable 要求全部 elements 已满足；conditional 列出未决要件或 missingFactIds；not_applicable 须有 not_met 要件或 contraryFactIds。',
    'missingFactIds 仅引用 unknown/disputed；contraryFactIds 仅引用 supported。breachStatus=not_established 须有反证、not_met 要件或已满足许可；仅缺少违法证据时用 undetermined。',
    'normRole=conditional_permission 必须填写 permission，其余为 null；许可 satisfied 对应 applicable+not_established，conditionally_allowed 对应 conditional，not_applicable 对应 not_applicable；许可判断不能写成违反。',
    'issues[].affectedIds 仅引用当前 payload.duties[].id，不接受 legalMatches 或 relations 的 ID；fact_gap 仅引用 unknown/disputed 事实，detail 只能 supplementary。',
    '法条引文、所属法律、条号和来源须与读取的原文一致；relations[].issues 引用当前 issues[].id，conflictsWith 引用 relations[].id；履行状态 performed/not_performed 须有已采纳行为事实。',
  ],
  faults: [
    'faults[].dutyId 引用同一参与方的上游 duties；evaluations[].faultId、legalMatchIds 引用本案记录，同一过错只评价一次。',
    'seriousness.status=scored 时 score 为 1..3，须引用 supported 违反或带 scenarioCondition 的 conditional 违反；其余状态 score=null，依据不足不默认评分。',
    'majorFaultCandidate=true 时须有 majorFaultReason 和 pendingReviewFactIds。',
    '证据阶段未更新却删除过错或待查条件时，填写 revisionBasis={reason,factIds} 说明纠正理由并引用已采纳事实；不得为取得等级清空未知项。',
  ],
  causation: [
    '每项上游过错均须有因果分析；analyses[].faultId 引用 faults[].id；issues[].affectedIds 仅引用当前 analyses[].id。',
    'conclusion=supported 须有至少两步机制、反事实事实依据，所依赖义务和事实均已成立，不能仍受非 supplementary 缺项影响。',
    '时间和参数非 null 时须有事实来源；未知保留 null。timingRequired=false 须写 timingReason，技术审核须写原因。',
    '作用无法判断用 conclusion=undetermined、contribution.score=null，不能据此免责或分责。not_established 表示已用 exclusionFactIds 的已采纳事实排除，且上游过错及相关 issues 不再有影响该原因的待查条件；0 不代替未知，3 须 supported，conditional 评分须 scenarioCondition。',
    '减速、停车或未变道本身不足以排除观察、制动迟延；横向碰撞也不能直接排除纵向速度的作用，须结合时序及可避免性。',
    '证据阶段未更新却取消必要时间、参数、技术审核或待查事项，或将未知/条件性分析改为确定结论时，须填写 revisionBasis={reason,factIds}。正常纠正可引用现有已采纳事实；未解决的上游缺项仍约束当前结论。',
  ],
  liability: [
    '存在待解决的事故事实时不能 recommendationType=supported；conditional 须有主情景、明确条件及 limitations，undetermined 的各方等级均为暂无法判断。',
    '情景覆盖全部参与方；责任卡片与主情景等级、causalIds 一致；承担责任者须有本人事故因果依据，不按分数求和分责。',
    '排除原因须有 exclusions 与事实依据，证据不足不等于免责；主情景须覆盖影响建议的全部条件性 issues，blocking 事项不能包装成确定情景。',
    '因果分析为 undetermined、仍有必要时间/参数未知或关键阻断时，相关方等级为暂无法判断。无法形成合理主情景可直接保存 recommendationType=undetermined、primaryScenarioId=null、各方暂无法判断，并列明 limitations；无需改写上游取得确定等级。',
    '校验失败一次修正全部 errors；missingValues 列出缺失 ID，relatedPaths 定位上游原因。不反复读取整案、猜测缺失 ID，或删去必需分析绕过校验。',
  ],
};

/**
 * Describe the stages without needing an existing case.
 * @param stage return one complete field outline, or omit for all six top-level summaries
 * @returns stage labels, required fields, and the requested detailed schema
 */
export function stageContracts(stage?: Stage): Record<string, StageContract> {
  return Object.fromEntries((stage ? [stage] : stages).map((s) => [s, {
    label: stageLabels[s],
    requiredFields: requiredFields(s),
    ...(stage ? {
      schema: describeSpec(stageSpecs[s]),
      notes: '对象仅允许列出的字段；minLength 按去除首尾空白后的长度校验，maxLength 按原文长度校验。保存时还会校验引用及事实、法规的一致性。',
      rules: stageRules[s],
    } : {}),
  }]));
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
  revisionBasis?: RevisionBasis;
}
/** An explicit correction of an earlier assessment using adopted facts. */
export interface RevisionBasis {
  reason: string;
  factIds: string[];
}
export interface Moment {
  value: string | null;
  factIds: string[];
}
export interface CausalAnalysis {
  id: string;
  faultId: string;
  outcome: 'accident' | 'damage';
  conclusion: 'supported' | 'conditional' | 'not_established' | 'undetermined';
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
  revisionBasis?: RevisionBasis;
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
