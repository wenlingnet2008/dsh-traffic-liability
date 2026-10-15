/**
 * Case store and stage validation. The model proposes stage payloads; this module owns stable
 * references, stage order, fact-adoption rules, legal-identity checks, S/C scoring rules, and
 * liability-scenario consistency, then persists one JSON record per case.
 */
import { randomUUID } from 'node:crypto';
import { applyReviewAnswer, intakeField, invalidateReview, reviewAnswerValue, reviewView, reviewIntakeSpec, reviewAnalysisSpec, type ReviewRecord } from './review-model.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clarificationFor, collectQuestions, evidenceForUpdate, latestAnswers, sameQuestion, type QuestionAnswer } from './questions.ts';
import {
  articleNumberOf,
  catalogSummary,
  lawFor,
  normalize,
  ruleHash,
  ruleInForce,
  type LawLibrary,
  type Rule,
} from './laws.ts';
import {
  requiredFields,
  stageLabels,
  stageSpecs,
  stages,
  validate,
  answerBatchSpec,
  type AnalysisIssue,
  type CausalAnalysis,
  type CausalExclusion,
  type Causation,
  type Duties,
  type EvidenceAnalysis,
  type Faults,
  type LegalMatch,
  type Liability,
  type Payload,
  type Registration,
  type Stage,
  type QuestionReply,
} from './schema.ts';

export type StageStatus = 'not_started' | 'analyzed' | 'needs_investigation' | 'stale';
export interface StageRecord {
  status: StageStatus;
  revision: number;
  payload: Payload | null;
  blockers: string[];
}
export interface CaseRecord {
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  lawCatalogVersion: string;
  stages: Record<Stage, StageRecord>;
  /** Absent in legacy cases; stage gaps still produce a question queue on read. */
  questionAnswers?: QuestionAnswer[];
  review?: ReviewRecord;
}

const idPattern = /^[A-Za-z0-9_-]{1,80}$/;
function atomicJson(path: string, data: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(temp, path);
}
const emptyStage = (): StageRecord => ({ status: 'not_started', revision: 0, payload: null, blockers: [] });

/** One JSON file per case under `dir`; writes are atomic and synchronous within one process. */
export class CaseStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private path(caseId: string) {
    if (!idPattern.test(caseId)) throw new Error(`无效的 caseId：${caseId}`);
    return join(this.dir, `${caseId}.json`);
  }
  /**
   * Summaries of every stored case, newest first.
   * @returns id, title, update time and the last stage that holds a result
   */
  list() {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.get(f.slice(0, -5)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        lastStage: stages.filter((s) => c.stages[s].payload).at(-1) ?? null,
      }));
  }
  /**
   * Load one case.
   * @param caseId case id
   * @returns the stored record
   * @throws when the case does not exist
   */
  get(caseId: string): CaseRecord {
    const path = this.path(caseId);
    if (!existsSync(path)) throw new Error(`案件不存在：${caseId}。首次保存 registration 时不要传 caseId`);
    return JSON.parse(readFileSync(path, 'utf8')) as CaseRecord;
  }
  /**
   * Create an empty case.
   * @param title display title
   * @param lawCatalogVersion catalog version the case was created with
   * @returns the new record
   */
  create(title: string, lawCatalogVersion: string): CaseRecord {
    const now = new Date().toISOString();
    const record: CaseRecord = {
      id: randomUUID(),
      title,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      lawCatalogVersion,
      stages: {
        registration: emptyStage(),
        evidence: emptyStage(),
        duties: emptyStage(),
        faults: emptyStage(),
        causation: emptyStage(),
        liability: emptyStage(),
      },
    };
    this.save(record);
    return record;
  }
  /**
   * Persist a record, bumping its revision and update time.
   * @param record case record to write
   */
  save(record: CaseRecord) {
    record.revision++;
    record.updatedAt = new Date().toISOString();
    atomicJson(this.path(record.id), record);
  }
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function unique(items: { id: string }[], label: string) {
  ensure(new Set(items.map((x) => x.id)).size === items.length, `${label} ID 重复`);
}
function references(ids: string[], items: { id: string }[], label: string) {
  for (const id of ids) ensure(items.some((x) => x.id === id), `${label} 引用不存在：${id}`);
}
const usable = (status: StageStatus) => status === 'analyzed' || status === 'needs_investigation';
const evidenceOf = (c: CaseRecord) => c.stages.evidence.payload as EvidenceAnalysis | null;
const factsOf = (c: CaseRecord) => evidenceOf(c)?.facts ?? [];
const isVisual = (kind: string) => kind === 'photo' || kind === 'video';
function checkFacts(c: CaseRecord, ids: string[], confirmed: boolean) {
  const facts = factsOf(c);
  references(ids, facts, '事实');
  if (confirmed)
    for (const id of ids)
      ensure(facts.find((x) => x.id === id)?.status === 'supported', `结论依赖未确认事实 ${id}，只能给出条件性分析`);
}
function ruleOf(lib: LawLibrary, ruleId: string, label: string): Rule {
  const entry = lib.byId.get(ruleId);
  ensure(entry, `${label} 引用的法规不在法规库中：${ruleId}。请先用 traffic_rule_search 定位并用 traffic_rule_read 读取`);
  return entry.rule;
}
function inForce(lib: LawLibrary, ruleId: string, reg: Registration, label: string) {
  const reason = ruleInForce(ruleOf(lib, ruleId, label), reg.occurredAt, reg.jurisdiction);
  ensure(!reason, `${label}：${reason}`);
}

function validateRegistration(p: Registration) {
  unique(p.parties, '参与方');
  unique(p.vehicles, '车辆');
  for (const v of p.vehicles) references([v.partyId], p.parties, '车辆参与方');
  for (const value of [p.occurredAt, p.reportedAt])
    if (value !== null) ensure(Number.isFinite(Date.parse(value)), '时间必须可解析，未知请填写 null');
}

function validateEvidence(p: EvidenceAnalysis, reg: Registration) {
  unique(p.materials, '材料');
  unique(p.observations, '提取记录');
  unique(p.facts, '事实');
  if (p.skippedReason) {
    ensure(p.observations.length === 0, '已有提取结果时不能跳过证据整理');
    if (p.skippedReason === 'no_materials') ensure(p.materials.length === 0, '已有材料时不能以无材料跳过');
    ensure(p.facts.every((f) => f.status === 'unknown'), '跳过证据整理时不能认定事实');
  }
  for (const o of p.observations) {
    references([o.materialId], p.materials, '提取记录的材料');
    references(o.partyIds, reg.parties, '参与方');
    references(o.vehicleIds, reg.vehicles, '车辆');
    if (o.kind === 'statement') ensure(o.speaker !== null, `陈述 ${o.id} 必须保留陈述主体 speaker`);
    const material = p.materials.find((m) => m.id === o.materialId)!;
    if (material.kind === 'statement') ensure(o.kind === 'statement', `当事人陈述材料 ${material.id} 的提取记录必须保留为 statement，不能转为客观观察`);
  }
  const visuals = p.materials.filter((m) => isVisual(m.kind));
  for (const fact of p.facts) {
    references([...fact.supportingObservationIds, ...fact.opposingObservationIds], p.observations, '提取记录');
    const checks = fact.visualChecks ?? [];
    ensure(new Set(checks.map((x) => x.materialId)).size === checks.length, `事实 ${fact.id} 的影像对照材料重复`);
    for (const check of checks) {
      const material = p.materials.find((m) => m.id === check.materialId);
      ensure(material && isVisual(material.kind), `事实 ${fact.id} 的影像对照必须引用 kind 为 photo 或 video 的材料`);
      references(check.observationIds, p.observations, '影像对照提取记录');
      for (const observationId of check.observationIds)
        ensure(
          p.observations.find((o) => o.id === observationId)!.materialId === material.id,
          `事实 ${fact.id} 的影像对照引用的提取记录不属于材料 ${material.id}`,
        );
      if (check.result !== 'unclear') ensure(check.observationIds.length > 0, `事实 ${fact.id} 的影像对照需要可追溯的提取记录；无法读取时请标记 unclear`);
      if (check.result === 'conflict') ensure(fact.status === 'disputed', `事实 ${fact.id} 与影像冲突，必须记录为 disputed`);
    }
    fact.adoptionBasis = null;
    if (fact.status === 'supported') {
      ensure(fact.supportingObservationIds.length > 0, `已采纳事实 ${fact.id} 必须有来源`);
      ensure(fact.opposingObservationIds.length === 0, `事实 ${fact.id} 有反驳材料，必须记录为 disputed`);
      const supporting = p.observations.filter((o) => fact.supportingObservationIds.includes(o.id));
      if (supporting.some((o) => o.kind === 'statement'))
        for (const visual of visuals) {
          const check = checks.find((x) => x.materialId === visual.id);
          ensure(
            check && (check.result === 'no_conflict' || check.result === 'not_relevant'),
            `事实 ${fact.id} 依赖陈述，采纳前须对影像材料 ${visual.id} 完成对照；未完成时保留 unknown，冲突时使用 disputed`,
          );
        }
      fact.adoptionBasis = supporting.some((o) => o.kind === 'observation') ? 'observation' : 'statement_adopted';
    }
  }
  const frames = p.behaviorFrames ?? [];
  unique(frames, '行为框架');
  const fact = (id: string) => p.facts.find((f) => f.id === id)!;
  for (const frame of frames) {
    references([frame.partyId, ...frame.relativePartyIds], reg.parties, '行为参与方');
    ensure(!frame.relativePartyIds.includes(frame.partyId), `行为 ${frame.id} 的相对方不能是本人`);
    references([...frame.factIds, ...frame.unknownFactIds], p.facts, '行为事实');
    references(frame.relatedBehaviorIds ?? [], frames, '关联行为');
    ensure(
      !/违法|违规|抢行|重大过错|过错|责任|违章/.test(`${frame.behaviorType} ${frame.description}`),
      `行为框架 ${frame.id} 只描述事实，不能写入违法、抢行、过错或责任评价`,
    );
    ensure(new Set(frame.candidateTags).size === frame.candidateTags.length, `行为 ${frame.id} 候选标签重复`);
    ensure(frame.unknownFactIds.every((id) => fact(id).status !== 'supported'), `行为 ${frame.id} 的 unknownFactIds 不能引用已采纳事实`);
    if (frame.status === 'supported')
      ensure(
        frame.factIds.length > 0 && frame.factIds.every((id) => fact(id).status === 'supported'),
        `行为 ${frame.id} 标为 supported 时，其事实依据必须全部为已采纳事实`,
      );
    if (frame.status === 'conditional')
      ensure(
        frame.unknownFactIds.length > 0 || frame.factIds.some((id) => fact(id).status !== 'supported'),
        `行为 ${frame.id} 标为 conditional 时必须指出未知或争议事实`,
      );
  }
  const questions = p.openQuestions ?? [];
  ensure(new Set(questions.map((q) => q.itemId)).size === questions.length, '补问事项 itemId 重复：同一事实事项只问一次');
  for (const q of questions) {
    if (q.partyId) references([q.partyId], reg.parties, '补问涉及的参与方');
    references(q.factIds ?? [], p.facts, '补问的事实');
    ensure((q.factIds ?? []).every((id) => fact(id).status !== 'supported'), `补问 ${q.itemId} 不能重复询问已采纳事实`);
  }
}

function validateIssues(c: CaseRecord, stage: 'duties' | 'causation', issues: AnalysisIssue[], affectable: string[]) {
  unique(issues, '待查事项');
  const upstream = stage === 'causation' ? ((c.stages.duties.payload as Duties).issues ?? []) : [];
  const facts = factsOf(c);
  const materials = evidenceOf(c)?.materials ?? [];
  for (const issue of issues) {
    ensure(!upstream.some((i) => i.id === issue.id), `待查事项 ${issue.id} 与上游阶段重名，不同阶段须使用不同 ID`);
    ensure(issue.affectedIds.every((id) => affectable.includes(id)), `待查事项 ${issue.id} 须引用当前阶段实际受影响的义务或因果分析`);
    references(issue.factIds, facts, `待查事项 ${issue.id} 的事实`);
    references(issue.evidenceIds, materials, `待查事项 ${issue.id} 的材料`);
    if (issue.kind === 'fact_gap') {
      ensure(issue.factIds.length > 0, `事实缺项 ${issue.id} 须定位到证据阶段的未知或争议事实，不能泛泛要求补证`);
      ensure(
        issue.factIds.every((id) => facts.find((f) => f.id === id)?.status !== 'supported'),
        `待查事项 ${issue.id}：已采纳事实不得再次作为事实缺项；单方来源或缺少独立佐证不是重新核查的理由`,
      );
    }
    if (issue.kind === 'evidence_conflict')
      ensure(
        issue.evidenceIds.length > 0 && issue.factIds.some((id) => facts.find((f) => f.id === id)?.status === 'disputed'),
        `证据冲突 ${issue.id} 须指向已记录的争议事实及具体材料，不得假设存在相反证据`,
      );
    if (issue.kind === 'detail') ensure(issue.severity === 'supplementary', `补充细节 ${issue.id} 不能阻止责任建议`);
    if (issue.kind === 'rule_gap') ensure(issue.severity !== 'conditional', `法条缺失 ${issue.id} 不能用假设替代；只将影响当前义务的法条缺失列为 blocking`);
  }
  return issues.filter((i) => i.severity === 'blocking').map((i) => `${i.id}：${i.question}；影响：${i.impact}`);
}

function validateLegalMatch(c: CaseRecord, lib: LawLibrary, m: LegalMatch, reg: Registration, pairs: Set<string>) {
  const frames = evidenceOf(c)?.behaviorFrames ?? [];
  const facts = factsOf(c);
  const status = (id: string) => facts.find((f) => f.id === id)!.status;
  references([m.behaviorId], frames, `法律匹配 ${m.id} 的行为`);
  const frame = frames.find((f) => f.id === m.behaviorId)!;
  ensure(frame.partyId === m.partyId, `法律匹配 ${m.id} 的主体与行为 ${frame.id} 的主体不一致`);
  const rule = ruleOf(lib, m.legalRef.ruleId, `法律匹配 ${m.id}`);
  const law = lawFor(rule, lib.catalog);
  ensure(law?.lawId === m.legalRef.lawId, `法律匹配 ${m.id} 的 lawId 与规则 ${rule.id} 所属法律不一致（应为 ${law?.lawId ?? '未知法律'}）`);
  ensure(
    m.legalRef.article.startsWith(rule.article) ||
      (articleNumberOf(m.legalRef.article) !== null && articleNumberOf(m.legalRef.article) === articleNumberOf(rule.article)),
    `法律匹配 ${m.id} 的条款号 ${m.legalRef.article} 与规则 ${rule.id}（${rule.article}）不一致`,
  );
  ensure(normalize(rule.text).includes(normalize(m.legalRef.quote)), `法律匹配 ${m.id} 引用的原文片段在 ${rule.id} 中不存在，不得改写或拼接法条`);
  ensure(m.legalRef.sourceUrl === rule.sourceUrl, `法律匹配 ${m.id} 的来源与规则 ${rule.id} 的来源不一致`);
  if (m.legalRef.sourceTextHash) ensure(m.legalRef.sourceTextHash === ruleHash(rule), `法律匹配 ${m.id} 的原文哈希与当前法规原文不一致`);
  const key = `${m.behaviorId}|${rule.id}|${m.legalRef.article}`;
  ensure(!pairs.has(key), `同一行为对同一条款重复匹配：${key}`);
  pairs.add(key);
  unique(m.elements, `法律匹配 ${m.id} 的要件`);
  for (const el of m.elements) {
    checkFacts(c, el.factIds, false);
    const statuses = el.factIds.map(status);
    if (el.status === 'met' || el.status === 'not_met')
      ensure(el.factIds.length > 0 && statuses.every((s) => s === 'supported'), `要件 ${el.id}（${m.id}）标为 ${el.status} 必须引用已采纳事实`);
    if (el.status === 'unknown') ensure(statuses.length > 0 && statuses.every((s) => s !== 'supported'), `要件 ${el.id}（${m.id}）标为 unknown 时须引用未知或争议事实，以便补问`);
    if (el.status === 'disputed') ensure(statuses.includes('disputed'), `要件 ${el.id}（${m.id}）标为 disputed 必须引用争议事实`);
  }
  checkFacts(c, [...m.missingFactIds, ...m.contraryFactIds], false);
  ensure(m.missingFactIds.every((id) => status(id) !== 'supported'), `法律匹配 ${m.id} 的 missingFactIds 只能引用未知或争议事实`);
  ensure(m.contraryFactIds.every((id) => status(id) === 'supported'), `法律匹配 ${m.id} 的反证必须是已采纳事实`);
  const unresolved = m.elements.some((e) => e.status === 'unknown' || e.status === 'disputed');
  const notMet = m.elements.some((e) => e.status === 'not_met');
  if (m.applicability === 'applicable') {
    ensure(!unresolved && !notMet, `法律匹配 ${m.id} 的要件未全部满足时不能标为 applicable`);
    inForce(lib, rule.id, reg, `法律匹配 ${m.id}`);
  }
  if (m.applicability === 'conditional') ensure(unresolved || m.missingFactIds.length > 0, `法律匹配 ${m.id} 标为 conditional 必须列出未决要件或缺失事实`);
  if (m.applicability === 'not_applicable') ensure(notMet || m.contraryFactIds.length > 0, `法律匹配 ${m.id} 标为不适用须有未满足的要件或反证`);
  if (m.normRole === 'conditional_permission') {
    ensure(m.permission !== null, `许可条款 ${m.id} 必须填写 permission`);
    ensure(
      m.breachStatus === 'not_established' || m.breachStatus === 'undetermined',
      `许可判断 ${m.id} 不能被写成已违反或条件违反；许可范围之外的独立义务须单独记录`,
    );
    const permission = m.permission!;
    if (permission.status === 'satisfied')
      ensure(m.applicability === 'applicable' && m.breachStatus === 'not_established', `许可条件已满足时 ${m.id} 的适用性应为 applicable，违反状态应为 not_established`);
    if (permission.status === 'conditionally_allowed') ensure(m.applicability === 'conditional', `有条件允许的 ${m.id} 适用性应为 conditional`);
    if (permission.status === 'not_applicable') ensure(m.applicability === 'not_applicable', `许可不适用的 ${m.id} 适用性应为 not_applicable`);
  } else ensure(m.permission === null, `非许可条款 ${m.id} 不应填写 permission`);
  if (m.breachStatus === 'supported') {
    ensure(m.applicability === 'applicable', `违反判断 ${m.id} 标为 supported 时适用性必须为 applicable`);
    ensure(m.elements.length > 0, `违反判断 ${m.id} 必须列出满足的要件和具体行为事实，不能只引用事故结果`);
    ensure(frame.status === 'supported', `违反判断 ${m.id} 依赖的行为 ${frame.id} 尚未成立，只能条件性判断`);
    ensure(m.contraryFactIds.length === 0, `存在反证时 ${m.id} 不能标为 supported`);
  }
  if (m.breachStatus === 'conditional') ensure(m.missingFactIds.length > 0 || unresolved, `条件性违反 ${m.id} 必须列出未决事实或要件`);
  if (m.breachStatus === 'not_established')
    ensure(
      m.contraryFactIds.length > 0 || notMet || m.permission?.status === 'satisfied',
      `${m.id} 标为不成立须有反证、未满足的要件或已满足的许可；没有材料证明违法不等于已证明合法`,
    );
}

/** Borrowing a motor lane under regulation article 70 must evaluate the motor vehicle's slow-and-yield duty too. */
function validateBorrowingDuties(lib: LawLibrary, p: Duties, reg: Registration) {
  const isArticle70 = (ruleId: string) => {
    const entry = lib.byId.get(ruleId);
    return !!entry && entry.lawId === 'road_traffic_safety_regulations' && entry.articleNumber === 70;
  };
  for (const d of p.duties) {
    if (!d.ruleIds.some(isArticle70) || !/借道|借用/.test(`${d.behavior}${d.trigger}`)) continue;
    ensure(
      !/不得妨碍.*(?:正常行驶|正常通行)/.test(d.requiredAction),
      '实施条例第七十条第二款没有“不得妨碍正常行驶车辆”的表述；请分别准确适用借道、机动车减速让行及第七十二条转弯规则',
    );
    if (reg.parties.find((x) => x.id === d.partyId)?.role !== 'nonmotor_driver') continue;
    for (const partyId of d.relativePartyIds.filter((id) => reg.parties.find((x) => x.id === id)?.role === 'motor_driver'))
      ensure(
        p.duties.some(
          (other) =>
            other.partyId === partyId &&
            other.relativePartyIds.includes(d.partyId) &&
            other.ruleIds.some(isArticle70) &&
            /减速.*让行/.test(other.requiredAction),
        ),
        '评估受阻借道时，须同时评估相对机动车依第七十条第二款的减速让行义务；触发条件未知可设 conditional',
      );
  }
}

function validateDuties(c: CaseRecord, lib: LawLibrary, p: Duties, reg: Registration): string[] {
  validateBorrowingDuties(lib, p, reg);
  unique(p.duties, '义务');
  unique(p.relations, '让行关系');
  for (const duty of p.duties) {
    references([duty.partyId, ...duty.relativePartyIds], reg.parties, '参与方');
    ensure(!duty.relativePartyIds.includes(duty.partyId), `义务 ${duty.id} 的相对方不能是义务主体本人`);
    checkFacts(c, duty.factIds, duty.status === 'supported');
    for (const ruleId of duty.ruleIds) {
      ruleOf(lib, ruleId, `义务 ${duty.id}`);
      if (duty.status === 'supported') inForce(lib, ruleId, reg, `义务 ${duty.id}`);
    }
  }
  const facts = factsOf(c);
  const status = (id: string) => facts.find((f) => f.id === id)!.status;
  for (const r of p.relations) {
    references([r.partyId, ...r.relativePartyIds], reg.parties, '让行关系参与方');
    ensure(!r.relativePartyIds.includes(r.partyId), `让行关系 ${r.id} 的相对方不能是义务主体本人`);
    for (const ruleId of r.ruleIds) ruleOf(lib, ruleId, `让行关系 ${r.id}`);
    checkFacts(c, r.factIds, r.applicability === 'applicable');
    references(r.issues, p.issues, `让行关系 ${r.id} 的待查事项`);
    references(r.conflictsWith, p.relations, `让行关系 ${r.id} 的冲突关系`);
    if (r.applicability === 'applicable') {
      ensure(r.factIds.length > 0, `让行关系 ${r.id} 适用时必须有事实依据`);
      for (const ruleId of r.ruleIds) inForce(lib, ruleId, reg, `让行关系 ${r.id}`);
    }
    if (r.applicability === 'conditional')
      ensure(r.issues.length > 0 || r.factIds.some((id) => status(id) !== 'supported'), `条件性让行关系 ${r.id} 须绑定待查事项或未知、争议事实`);
    if (r.performance === 'performed' || r.performance === 'not_performed')
      ensure(r.factIds.some((id) => status(id) === 'supported'), `让行关系 ${r.id} 的履行状态须有已采纳的行为事实支持；发生碰撞本身不证明未让行`);
    if (r.relationType === 'no_relation') ensure(r.performance === 'not_applicable', `无让行关系的 ${r.id} 不应有履行状态`);
  }
  if (p.legalMatches.length) {
    ensure((evidenceOf(c)?.behaviorFrames ?? []).length > 0, '法律匹配需要先在 evidence 阶段形成行为框架（behaviorFrames）');
    unique(p.legalMatches, '法律匹配');
    const pairs = new Set<string>();
    for (const m of p.legalMatches) validateLegalMatch(c, lib, m, reg, pairs);
  }
  return validateIssues(c, 'duties', p.issues, p.duties.map((d) => d.id));
}

function validateFaults(c: CaseRecord, p: Faults) {
  const duties = (c.stages.duties.payload as Duties).duties;
  const matches = (c.stages.duties.payload as Duties).legalMatches;
  unique(p.faults, '过错');
  for (const fault of p.faults) {
    references([fault.dutyId], duties, `过错 ${fault.id} 的义务`);
    ensure(duties.find((x) => x.id === fault.dutyId)?.partyId === fault.partyId, `过错 ${fault.id} 的主体与义务主体不一致`);
    checkFacts(c, fault.factIds, false);
  }
  unique(p.evaluations, '过错评价');
  ensure(new Set(p.evaluations.map((e) => e.faultId)).size === p.evaluations.length, '同一过错只能有一条评价；重复法条或同义描述增加依据，不增加过错数量');
  for (const e of p.evaluations) {
    references([e.faultId], p.faults, `评价 ${e.id} 对应的过错`);
    const fault = p.faults.find((f) => f.id === e.faultId)!;
    ensure(fault.partyId === e.partyId, `评价 ${e.id} 的主体与过错 ${fault.id} 的主体不一致`);
    references(e.legalMatchIds, matches, `评价 ${e.id} 引用的法律匹配`);
    const linked = matches.filter((m) => e.legalMatchIds.includes(m.id));
    ensure(linked.every((m) => m.partyId === e.partyId), `评价 ${e.id} 引用了其他参与方的法律匹配`);
    checkFacts(c, e.pendingReviewFactIds, false);
    const supportedBreach = linked.some((m) => m.breachStatus === 'supported');
    const conditionalBreach = linked.some((m) => m.breachStatus === 'conditional');
    if (e.seriousness.status === 'scored') {
      ensure(e.seriousness.score !== null, `评价 ${e.id} 已评分时 score 不能为空`);
      ensure(linked.length > 0, `评价 ${e.id} 评分必须引用法律匹配`);
      ensure(fault.category !== 'insufficient', `证据不足的过错 ${fault.id} 不能评分`);
      ensure(
        supportedBreach || (conditionalBreach && e.scenarioCondition !== null),
        `评价 ${e.id} 只能对已成立的违反评分；条件性违反须写明情景条件，该分值不计入当前成立分`,
      );
      if (supportedBreach) ensure(e.scenarioCondition === null, `评价 ${e.id} 已有成立的违反判断，不应标为条件情景分`);
    } else ensure(e.seriousness.score === null, `评价 ${e.id} 未评分时 score 必须为 null，不能用 0 或默认值代替未知`);
    if (e.majorFaultCandidate) ensure(e.majorFaultReason !== null && e.pendingReviewFactIds.length > 0, `重大过错候选 ${e.id} 必须同时填写触发理由和待核对事实`);
  }
}

function validateContribution(c: CaseRecord, a: CausalAnalysis) {
  const k = a.contribution;
  if (k.status !== 'scored') {
    ensure(k.score === null, `因果分析 ${a.id} 未评分时作用分必须为 null，不能用 0 代替未知`);
    return;
  }
  ensure(k.score !== null, `因果分析 ${a.id} 作用分已评分时 score 不能为空`);
  if (k.score === 0) {
    ensure(a.conclusion === 'not_established', `因果分析 ${a.id} 作用分为 0 时，结论必须为不成立`);
    ensure(k.exclusionFactIds.length > 0, `因果分析 ${a.id} 作用分 0 必须有排除事故作用的事实依据；未知应填 null`);
    checkFacts(c, k.exclusionFactIds, true);
    return;
  }
  ensure(a.conclusion !== 'not_established', `因果分析 ${a.id} 结论不成立时作用分只能为 0 或 null`);
  if (k.score === 3) ensure(a.conclusion === 'supported' && k.scenarioCondition === null, `因果分析 ${a.id} 作用分 3 须有已成立的因果结论，不能用于条件情景`);
  if (a.conclusion === 'conditional') ensure(k.scenarioCondition !== null, `条件性因果结论 ${a.id} 的作用分必须写明情景条件`);
  if (a.conclusion === 'supported') ensure(k.scenarioCondition === null, `已成立的因果结论 ${a.id} 不应标为条件情景分`);
}

function validateCausation(c: CaseRecord, p: Causation): string[] {
  const faults = (c.stages.faults.payload as Faults).faults;
  const duties = (c.stages.duties.payload as Duties).duties;
  const blockers: string[] = [];
  unique(p.analyses, '因果分析');
  for (const a of p.analyses) {
    references([a.faultId], faults, `因果分析 ${a.id} 的过错`);
    const fault = faults.find((x) => x.id === a.faultId)!;
    const supported = a.conclusion === 'supported';
    const timingOptional = a.timingRequired === false;
    if (timingOptional) ensure(!!a.timingReason?.trim(), `因果分析 ${a.id} 声明精确时序不影响判断时必须用 timingReason 说明理由`);
    if (supported) {
      ensure(a.mechanism.length >= 2 && a.counterfactual.factIds.length > 0, `因果分析 ${a.id} 的确定结论需要至少两步中间机制和反事实事实依据`);
      ensure(!p.issues.some((i) => i.affectedIds.includes(a.id) && i.severity !== 'supplementary'), `因果分析 ${a.id} 仍受条件性缺项影响时，conclusion 应为 conditional`);
      ensure(fault.category === a.outcome, `因果分析 ${a.id}：独立违法、证据不足或损害扩大过错不能直接作为碰撞原因`);
      ensure(fault.pendingConditions.length === 0, `因果分析 ${a.id}：过错仍有待查条件，不能支持确定因果结论`);
      ensure(duties.find((x) => x.id === fault.dutyId)!.status === 'supported', `因果分析 ${a.id}：义务为条件性时不能支持确定因果结论`);
      checkFacts(c, fault.factIds, true);
      ensure(a.disputedFactIds.length === 0, `因果分析 ${a.id} 依赖争议事实，结论必须是条件性的`);
    }
    for (const step of a.mechanism) checkFacts(c, step.factIds, supported);
    checkFacts(c, a.counterfactual.factIds, supported);
    checkFacts(c, a.disputedFactIds, false);
    ensure(a.disputedFactIds.every((id) => factsOf(c).find((f) => f.id === id)?.status !== 'supported'), `因果分析 ${a.id}：已采纳事实不能在下游重新标为争议`);
    const labels: Record<string, string> = { hazardAppeared: '危险出现', observable: '可被合理观察', discovered: '实际发现', responseStarted: '开始采取措施' };
    for (const [key, moment] of Object.entries(a.timeline)) {
      checkFacts(c, moment.factIds, supported);
      if (moment.value !== null) ensure(moment.factIds.length > 0, `因果分析 ${a.id}：${labels[key]}时间必须有事实来源`);
      if (a.conclusion !== 'not_established' && moment.value === null && !timingOptional) blockers.push(`${a.id}：${labels[key]}的关键时间未知，需要补充调查`);
    }
    for (const param of a.parameters) {
      checkFacts(c, param.factIds, supported);
      if (param.value !== null) ensure(param.factIds.length > 0, `因果分析 ${a.id}：参数 ${param.name} 缺少来源`);
      if (param.range) {
        ensure(param.range[0]! <= param.range[1]!, `因果分析 ${a.id}：参数 ${param.name} 区间倒置`);
        if (param.value !== null) ensure(param.range[0]! <= param.value && param.value <= param.range[1]!, `因果分析 ${a.id}：参数 ${param.name} 不在区间内`);
      }
      if (param.required && (param.value === null || param.factIds.length === 0)) blockers.push(`${a.id}：关键参数 ${param.name} 未知，返回事实调查`);
    }
    if (a.technicalReviewRequired) {
      ensure(a.technicalReviewReason !== null, `因果分析 ${a.id} 需要专业审核时必须说明原因`);
      blockers.push(`${a.id}：需要鉴定或专业审核：${a.technicalReviewReason}`);
    }
    validateContribution(c, a);
  }
  for (const fault of faults) ensure(p.analyses.some((a) => a.faultId === fault.id), `过错 ${fault.id} 缺少因果分析`);
  blockers.push(...validateIssues(c, 'causation', p.issues, p.analyses.map((a) => a.id)));
  return blockers;
}

const fullOrNone = new Set(['全责', '无责']);
function assertGradeCombination(assignments: { partyId: string; level: string }[]) {
  const levels = assignments.map((p) => p.level);
  const full = levels.filter((l) => l === '全责').length;
  ensure(full <= 1 && (!full || levels.every((l) => fullOrNone.has(l))), '全责建议与其他参与方等级相互矛盾');
  if (levels.length === 2 && !levels.includes('暂无法判断')) {
    const valid = [['全责', '无责'], ['主责', '次责'], ['同责', '同责']];
    ensure(valid.some((pair) => [...pair].sort().join() === [...levels].sort().join()), '双方责任组合不一致，应为全责/无责、主责/次责或同责/同责');
  }
}
function causalRequirements(a: CausalAnalysis) {
  const result: string[] = [];
  if (a.conclusion === 'not_established') return result;
  const timingOptional = a.timingRequired === false && !!a.timingReason?.trim();
  if (!timingOptional && Object.values(a.timeline).some((m) => m.value === null)) result.push('关键时间未知');
  if (a.parameters.some((p) => p.required && (p.value === null || !p.factIds.length))) result.push('关键参数未知');
  if (a.technicalReviewRequired) result.push('需要专业技术审核');
  return result;
}
function relatedIssues(c: CaseRecord, causalIds: string[]) {
  const causal = c.stages.causation.payload as Causation;
  const duties = c.stages.duties.payload as Duties;
  const faults = (c.stages.faults.payload as Faults).faults;
  const dutyIds = causal.analyses.filter((a) => causalIds.includes(a.id)).map((a) => faults.find((f) => f.id === a.faultId)!.dutyId);
  return [
    ...duties.issues.filter((i) => i.affectedIds.some((id) => dutyIds.includes(id))),
    ...causal.issues.filter((i) => i.affectedIds.some((id) => causalIds.includes(id))),
  ];
}

function validateLiability(c: CaseRecord, lib: LawLibrary, p: Liability, reg: Registration) {
  const causal = c.stages.causation.payload as Causation;
  const duties = c.stages.duties.payload as Duties;
  const faults = (c.stages.faults.payload as Faults).faults;
  const facts = factsOf(c);
  unique(p.parties.map((x) => ({ id: x.partyId })), '责任参与方');
  ensure(p.parties.length === reg.parties.length, '责任建议应覆盖所有参与方');
  const hasOwnCause = (partyId: string, ids: string[]) =>
    causal.analyses.some((a) => ids.includes(a.id) && a.outcome === 'accident' && a.conclusion !== 'not_established' && faults.find((f) => f.id === a.faultId)?.partyId === partyId);
  for (const party of p.parties) {
    references([party.partyId], reg.parties, '责任参与方');
    references(party.causalIds, causal.analyses, `参与方 ${party.partyId} 的因果分析`);
    if (party.level === '暂无法判断') continue;
    const noFault = party.level === '无责';
    ensure((noFault || party.causalIds.length > 0) && party.ruleIds.length > 0, `参与方 ${party.partyId} 的责任等级必须引用因果分析和责任评价规则`);
    const rules = party.ruleIds.map((id) => ruleOf(lib, id, `参与方 ${party.partyId} 的责任规则`));
    for (const r of rules) inForce(lib, r.id, reg, `参与方 ${party.partyId} 的责任评价法条`);
    ensure(rules.some((r) => /责任/.test(r.applicability) && /责任/.test(r.text)), `参与方 ${party.partyId} 缺少责任评价规则，不能仅凭通行义务推导等级`);
    if (!noFault) ensure(hasOwnCause(party.partyId, party.causalIds), `参与方 ${party.partyId} 承担责任须有该方自身的事故因果依据；仅有义务或行为未知，不能分配责任`);
    const linked = causal.analyses.filter((a) => party.causalIds.includes(a.id));
    if (linked.some((a) => a.conclusion === 'conditional')) ensure(party.conditions.length > 0, `参与方 ${party.partyId} 的条件性因果结论必须在责任建议中列出条件`);
    const own = causal.analyses.filter((a) => faults.find((f) => f.id === a.faultId)?.partyId === party.partyId && a.conclusion !== 'not_established').map((a) => a.id);
    const relevant = [...new Set([...party.causalIds, ...own])];
    ensure(!relatedIssues(c, relevant).some((i) => i.severity === 'blocking'), `参与方 ${party.partyId} 的责任建议仍有关键事实或法规阻断，须保留暂无法判断`);
    ensure(!causal.analyses.filter((a) => relevant.includes(a.id)).some((a) => causalRequirements(a).length), `参与方 ${party.partyId} 的关键因果或法规问题尚未解决，责任等级应暂无法判断`);
  }
  assertGradeCombination(p.parties);
  const allIssues = [...duties.issues, ...causal.issues];
  const checkExclusions = (assignments: { partyId: string; level: string }[], exclusions: CausalExclusion[], excludedIds: string[], primary: boolean) => {
    ensure(new Set(exclusions.map((e) => e.causalId)).size === exclusions.length, '排除原因的说明不能重复');
    ensure(excludedIds.length === exclusions.length && exclusions.every((e) => excludedIds.includes(e.causalId)), '每个被排除的原因须有 exclusions 说明依据，未查明不等于无责');
    for (const e of exclusions) {
      const cause = causal.analyses.find((a) => a.id === e.causalId);
      ensure(!!cause, `排除的因果分析不存在：${e.causalId}`);
      ensure(cause!.conclusion !== 'supported', `已成立的事故原因 ${e.causalId} 不能在责任阶段直接排除；请先修正上游因果分析`);
      ensure(!/未查明|未确认|无法确认|不能确认|不清楚|未提供|缺乏证据|没有证据|证据不足/.test(e.explanation), `排除 ${e.causalId}：不能用未查明或证据不足作为免责依据；请写明确的事实或假设`);
      if (e.basis === 'supported_fact') {
        ensure(cause!.conclusion === 'not_established', `排除 ${e.causalId}：事实性排除须先在因果阶段明确不成立`);
        ensure(e.factIds.length > 0 && e.factIds.every((id) => facts.some((f) => f.id === id && f.status === 'supported')), `排除 ${e.causalId}：事实性排除须引用已采纳事实`);
      } else {
        const related = relatedIssues(c, [e.causalId]);
        ensure(e.issueIds.length > 0 && e.issueIds.every((id) => related.some((i) => i.id === id && i.severity === 'conditional')), `排除 ${e.causalId}：假设性排除须绑定该原因的条件性缺项，不能假设推翻已知事实`);
        ensure(!primary || !assignments.some((a) => a.level === '全责'), '其他参与方仅凭假设免责时，不得将全责情景选为默认结论；可作为其他可能情景');
        ensure(p.recommendationType === 'conditional', '假设性免责只能用于条件性建议');
      }
    }
    for (const a of assignments.filter((a) => a.level === '无责')) {
      const ownCauses = causal.analyses.filter((cause) => cause.outcome === 'accident' && faults.find((f) => f.id === cause.faultId)?.partyId === a.partyId);
      ensure(ownCauses.every((cause) => excludedIds.includes(cause.id)), `参与方 ${a.partyId} 无责必须逐项说明其候选事故原因为何被排除；尚不能成立不等于已经排除`);
    }
  };
  ensure(new Set(p.scenarios.map((s) => s.id)).size === p.scenarios.length, '情景 ID 重复');
  const conditions = new Set<string>();
  for (const s of p.scenarios) {
    ensure(s.excludedCausalIds.every((id) => causal.analyses.some((a) => a.id === id)), `情景 ${s.id} 排除的原因不存在`);
    for (const a of s.assignments) {
      ensure(a.causalIds.every((id) => causal.analyses.some((x) => x.id === id)), `情景 ${s.id} 的分责引用了不存在的因果分析`);
      ensure(!a.causalIds.some((id) => s.excludedCausalIds.includes(id)), `情景 ${s.id} 已经排除的原因不能再用于分责`);
      if (a.level !== '无责' && a.level !== '暂无法判断') ensure(hasOwnCause(a.partyId, a.causalIds), `情景 ${s.id} 中 ${a.partyId} 承担责任必须有自身因果依据，不能因行为未知而分配次责`);
    }
    const normalized = s.condition.replace(/[\s，,。；;：:]/g, '');
    ensure(!conditions.has(normalized), '同一条件不能列出两套不同责任结果');
    conditions.add(normalized);
    ensure(
      s.assignments.length === p.parties.length && new Set(s.assignments.map((a) => a.partyId)).size === p.parties.length && s.assignments.every((a) => p.parties.some((x) => x.partyId === a.partyId)),
      `情景 ${s.id} 必须覆盖全部参与方且不能重复`,
    );
    assertGradeCombination(s.assignments);
    checkExclusions(s.assignments, s.exclusions, s.excludedCausalIds, s.id === p.primaryScenarioId);
    ensure(s.issueIds.every((id) => allIssues.some((i) => i.id === id)), `情景 ${s.id} 引用的待查事项不存在`);
    ensure(s.issueIds.every((id) => allIssues.find((i) => i.id === id)?.severity !== 'blocking'), `情景 ${s.id}：关键阻断不能包装为已具备依据的情景建议`);
  }
  const primary = p.scenarios.find((s) => s.id === p.primaryScenarioId);
  if (p.recommendationType === 'conditional') {
    ensure(!!primary, '条件性责任建议必须选定一个主情景并写明成立条件');
    ensure(p.parties.some((x) => x.level !== '暂无法判断'), '条件性建议至少给出一方的责任等级，不能全部暂无法判断');
    ensure(p.parties.every((x) => primary!.assignments.find((a) => a.partyId === x.partyId)?.level === x.level), '主情景与责任卡片等级不一致');
    ensure(p.parties.every((x) => !x.causalIds.some((id) => primary!.excludedCausalIds.includes(id))), '责任卡片不能引用主情景已排除的原因');
    ensure(
      p.parties.every((x) => [...x.causalIds].sort().join('|') === [...(primary!.assignments.find((a) => a.partyId === x.partyId)?.causalIds ?? [])].sort().join('|')),
      '责任卡片与主情景采用的因果依据不一致',
    );
    const conditional = relatedIssues(c, p.parties.flatMap((x) => x.causalIds)).filter((i) => i.severity === 'conditional');
    ensure(conditional.every((i) => primary!.issueIds.includes(i.id)), '主情景须覆盖影响建议的全部条件性缺项');
  } else {
    ensure(p.primaryScenarioId === null, '仅条件性建议可以选择主情景');
    if (p.recommendationType === 'undetermined') ensure(p.parties.every((x) => x.level === '暂无法判断'), '无法判断时不得在责任卡片中给确定等级');
    else {
      checkExclusions(p.parties, p.exclusions, p.exclusions.map((e) => e.causalId), true);
      ensure(p.parties.every((x) => x.level !== '暂无法判断'), '有依据的建议必须覆盖全部参与方');
      const linked = p.parties.flatMap((x) => x.causalIds);
      ensure(
        !causal.analyses.some((a) => linked.includes(a.id) && a.conclusion === 'conditional') && !relatedIssues(c, linked).some((i) => i.severity === 'conditional'),
        '仍依赖条件时应输出条件性建议',
      );
    }
  }
}

export interface SubmitInput {
  caseId?: string;
  title?: string;
  stage: Stage;
  payload: unknown;
}
export interface SubmitResult {
  saved: true;
  caseId: string;
  stage: Stage;
  status: StageStatus;
  blockers: string[];
  nextStage: Stage | null;
  clarification: ReturnType<typeof clarificationFor>;
  note: string;
}

/**
 * Save a user reply batch atomically; substantive answers require a new evidence analysis.
 * @param store case store
 * @param caseId existing case id
 * @param replies one to three attributed replies to recorded questions
 * @returns question state and the evidence draft for incorporating the user's statements
 * @throws for malformed replies, unknown questions, or a duplicate factual item in the batch
 */
export function recordAnswers(store: CaseStore, caseId: string, replies: unknown) {
  const violations = validate(answerBatchSpec, replies);
  ensure(!violations.length, `补充回答结构不合法：${violations.join('；')}`);
  const record = store.get(caseId);
  const questions = collectQuestions(record);
  const latest = latestAnswers(record);
  const batch = replies as QuestionReply[];
  const prepared: QuestionAnswer[] = [];
  for (const reply of batch) {
    const question = questions.find((q) => q.itemId === reply.itemId) ?? latest.find((a) => a.itemId === reply.itemId)?.questionRecord;
    ensure(question, `补问事项不存在：${reply.itemId}。请先用 traffic_case_read 读取问题，不能编造用户回答`);
    ensure(!prepared.some((a) => sameQuestion(a.questionRecord, question)), '同一补问事项不能在一次提交中重复回答');
    ensure(reply.status !== 'answered' || !/^(?:不清楚|不知道|不确定|记不清|无法确认|unknown|not sure)[。.!！\s]*$/i.test(reply.answer.trim()), '用户不清楚时 status 必须为 unknown，不能作为确定事实');
    const prior = latest.find((a) => sameQuestion(a.questionRecord, question));
    prepared.push({
      ...reply, id: randomUUID(), questionRecord: structuredClone(question), receivedAt: new Date().toISOString(),
      appliedAtRevision: question.target === 'review_intake' || (reply.status === 'unknown' && prior?.status !== 'answered') ? record.revision + 1 : null,
    });
  }
  const changes = prepared.filter((a) => {
    const prior = latest.find((p) => sameQuestion(p.questionRecord, a.questionRecord));
    const restoresReviewField = a.questionRecord.target === 'review_intake' && record.review &&
      intakeField(record.review.intake, a.itemId.replace(/^review\.field\./, '')) !== reviewAnswerValue(a);
    return !prior || prior.status !== a.status || prior.answer !== a.answer || prior.speaker !== a.speaker || restoresReviewField;
  });
  if (changes.length) {
    for (const answer of changes) applyReviewAnswer(record, answer);
    record.questionAnswers = [...(record.questionAnswers ?? []), ...changes];
    if (changes.some((a) => a.appliedAtRevision === null)) {
      invalidateReview(record);
      for (const stage of stages.slice(1)) {
        const saved = record.stages[stage];
        if (!saved.payload) continue;
        saved.status = 'stale';
        saved.blockers = ['用户已补充关键事实，须更新证据并重新分析'];
      }
    }
    store.save(record);
  }
  const clarification = clarificationFor(record);
  return {
    saved: true, caseId, clarification, evidenceForUpdate: evidenceForUpdate(record),
    nextStage: stages.find((s) => !usable(record.stages[s].status)) ?? null,
    note: clarification.status === 'needs_reanalysis'
      ? '回答已保存为当事人陈述。请使用 evidenceForUpdate 更新 facts 和 behaviorFrames，完成影像对照后保存 evidence，再按顺序重做下游分析；不得直接把回答转换成责任结论。'
      : clarification.status === 'needs_answers'
      ? '本次回答已记录。请先保存现有可形成的分析，受阻部分保持暂无法判断，再向用户提出 clarification.questions 中尚未回答的问题并说明影响；不清楚的事项不再重复询问，不要求答完所有问题。'
      : '回答已记录。不清楚的事项保持未知，不再重复询问；尚未回答的条件性问题可后续补充，先在明确条件或暂无法判断的前提下继续分析。',
  };
}

function validateAnswerIncorporation(record: CaseRecord, evidence: EvidenceAnalysis) {
  for (const answer of latestAnswers(record).filter((a) => a.appliedAtRevision === null)) {
    const materialId = `reply_m_${answer.id}`;
    const observationId = `reply_o_${answer.id}`;
    const observation = evidence.observations.find((o) => o.id === observationId);
    ensure(evidence.materials.some((m) => m.id === materialId && m.kind === 'statement'), `补充回答 ${answer.itemId} 须保留 evidenceForUpdate 中的陈述材料`);
    ensure(
      observation?.materialId === materialId && observation.kind === 'statement' && observation.content === answer.answer && observation.speaker === answer.speaker,
      `补充回答 ${answer.itemId} 须保留原话和陈述主体，不能遗漏或改写为客观观察`,
    );
    for (const factId of answer.questionRecord.factIds) {
      const fact = evidence.facts.find((f) => f.id === factId);
      ensure(fact && [...fact.supportingObservationIds, ...fact.opposingObservationIds].includes(observationId), `补充回答 ${answer.itemId} 须用于更新关联事实 ${factId}；不确定或有冲突时保持 unknown 或 disputed`);
      ensure(answer.status !== 'unknown' || fact?.status !== 'supported', `补充回答 ${answer.itemId} 已更正为不清楚，关联事实 ${factId} 须重新核对并保留 unknown 或 disputed`);
    }
  }
}

/**
 * Validate and persist one stage result. Downstream stages holding results become `stale`.
 * @param store case store
 * @param lib law library used for legal-identity checks
 * @param input stage, payload, and the case id (omitted only when creating a case at registration)
 * @returns the saved stage status and blockers
 * @throws a Chinese message naming the first structural or consistency violation to fix
 */
export function submitStage(store: CaseStore, lib: LawLibrary, input: SubmitInput): SubmitResult {
  const violations = validate(stageSpecs[input.stage], input.payload);
  if (violations.length) {
    const shown = violations.slice(0, 12);
    throw new Error(`${stageLabels[input.stage]}结果结构不合法：${shown.join('；')}${violations.length > shown.length ? `；另有 ${violations.length - shown.length} 处` : ''}`);
  }
  const payload = structuredClone(input.payload) as Payload;
  let record: CaseRecord;
  if (input.stage === 'registration' && !input.caseId) {
    const reg = payload as Registration;
    record = store.create(input.title?.trim() || (reg.location ? `${reg.location}的事故` : '未命名事故'), lib.catalog.version);
  } else {
    ensure(input.caseId, `保存 ${input.stage} 阶段必须传 caseId`);
    record = store.get(input.caseId);
  }
  const index = stages.indexOf(input.stage);
  for (const prior of stages.slice(0, index)) ensure(usable(record.stages[prior].status), `请先完成前置阶段：${prior}（${stageLabels[prior]}）`);
  const reg = input.stage === 'registration' ? (payload as Registration) : (record.stages.registration.payload as Registration);
  let blockers: string[] = [];
  switch (input.stage) {
    case 'registration':
      validateRegistration(payload as Registration);
      break;
    case 'evidence':
      validateEvidence(payload as EvidenceAnalysis, reg);
      validateAnswerIncorporation(record, payload as EvidenceAnalysis);
      break;
    case 'duties':
      blockers = validateDuties(record, lib, payload as Duties, reg);
      break;
    case 'faults':
      validateFaults(record, payload as Faults);
      break;
    case 'causation':
      blockers = validateCausation(record, payload as Causation);
      break;
    case 'liability': {
      const clarification = clarificationFor(record, true);
      const type = (payload as Liability).recommendationType;
      ensure(type !== 'supported' || clarification.pendingCount === 0, '存在影响定责的待回答问题，不能给出无条件的确定建议；可先保存明确假设下的条件性建议或暂无法判断，不要求答完所有问题');
      ensure(type !== 'supported' || clarification.unresolved.length === 0, '关键补问事项仍然未知或存在争议，只能给出明确条件下的建议或暂无法判断');
      ensure(!(clarification.pendingCount || clarification.unresolved.length) || (payload as Liability).limitations.length > 0, '仍有未解决的事故事实，责任建议须在 limitations 中说明限制');
      validateLiability(record, lib, payload as Liability, reg);
      break;
    }
  }
  for (const later of stages.slice(index + 1)) {
    const s = record.stages[later];
    s.status = s.payload ? 'stale' : 'not_started';
    s.blockers = s.payload ? ['上游分析已更新，须重新提交'] : [];
  }
  const status: StageStatus = blockers.length ? 'needs_investigation' : 'analyzed';
  record.stages[input.stage] = { status, revision: record.revision + 1, payload, blockers };
  invalidateReview(record);
  if (input.stage === 'evidence') {
    for (const answer of latestAnswers(record)) if (answer.appliedAtRevision === null) answer.appliedAtRevision = record.revision + 1;
  }
  store.save(record);
  const clarification = clarificationFor(record);
  const nextStage = stages[index + 1] ?? null;
  let base = blockers.length
    ? `${stageLabels[input.stage]}已保存，但存在阻断事项；可继续下一阶段，责任建议中受影响的部分须保持暂无法判断。`
    : nextStage
      ? `${stageLabels[input.stage]}已保存。下一阶段：${nextStage}（${stageLabels[nextStage]}）。`
      : `${stageLabels[input.stage]}已保存${clarification.status === 'complete' ? '，分析完成' : ''}。`;
  if (clarification.status === 'needs_answers') base += ' 存在关键事实阻断，请向用户提出 clarification.questions 中的问题并说明影响；先保存当前可形成的分析，受阻部分保持暂无法判断，不要替用户作答或要求答完所有问题。';
  if (clarification.status === 'limited') base += ' 条件性事实或申请资料仍待补充，可先完成附条件的分析或暂无法判断的结果；不清楚的事项不再重复询问，未解决事实须列明限制。申请资料缺项仅限制申请书待签版。';
  return {
    saved: true,
    caseId: record.id,
    stage: input.stage,
    status,
    blockers,
    nextStage,
    clarification,
    note: reg.occurredAt === null ? `${base} 事发日期未知，法条效力版本未核对，请在 limitations 中注明。` : base,
  };
}

/**
 * Model-facing case view: registration, adopted facts, usable upstream results, and the field contract.
 * @param store case store
 * @param lib law library for the catalog summary
 * @param caseId case id
 * @returns the view
 */
export function readCase(store: CaseStore, lib: LawLibrary, caseId: string) {
  const c = store.get(caseId);
  const adoptedFacts = c.stages.evidence.status === 'stale' ? [] : factsOf(c).filter((f) => f.status === 'supported');
  const nextStage = stages.find((s) => !usable(c.stages[s].status)) ?? null;
  return {
    id: c.id,
    title: c.title,
    revision: c.revision,
    updatedAt: c.updatedAt,
    nextStage,
    adoptedFacts,
    clarification: clarificationFor(c),
    evidenceForUpdate: evidenceForUpdate(c),
    review: reviewView(c),
    reviewContract: { intake: reviewIntakeSpec, analysis: reviewAnalysisSpec },
    stages: Object.fromEntries(
      stages.map((s) => {
        const r = c.stages[s];
        return [s, { status: r.status, blockers: r.blockers, payload: usable(r.status) ? r.payload : null }];
      }),
    ),
    stageContract: Object.fromEntries(stages.map((s) => [s, { label: stageLabels[s], requiredFields: requiredFields(s) }])),
    lawCatalog: catalogSummary(lib),
  };
}
