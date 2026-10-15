/** Optional official-determination review contracts; original findings never become adopted facts here. */
import type { CaseRecord } from './engine.ts';
import type { CaseQuestion, QuestionAnswer } from './questions.ts';
import { validate, type Spec } from './schema.ts';

export const reviewCategories = ['facts', 'evidence', 'law', 'causation', 'liability', 'procedure'] as const;
export const reviewLabels = { facts: '事实认定', evidence: '主要证据', law: '法律适用', causation: '因果作用', liability: '责任划分', procedure: '调查及认定程序' };
export interface ReviewIntake {
  applicant: { kind: 'individual' | 'organization'; name: string | null; identityNumber: string | null; address: string | null; phone: string | null; details: string | null; representative: string | null };
  original: { number: string | null; authority: string | null; issuedOn: string | null; servedOn: string | null; source: string; text: string; conclusions: { id: string; locator: string; quote: string; responsibility: string | null }[] };
  accidentSummary: string | null;
  userRequest: string | null;
  receivingAuthority: string | null;
  applicationDate: string | null;
  priorReview: 'none' | 'submitted' | 'concluded' | 'unknown';
  evidence: { id: string; title: string; source: string; locator: string; quote: string; availability: 'available' | 'to_obtain' }[];
}
export interface ReviewAssessment {
  id: string;
  category: (typeof reviewCategories)[number];
  status: 'supported' | 'pending' | 'insufficient';
  originalConclusionIds: string[];
  evidenceIds: string[];
  factIds: string[];
  legalRefs: { ruleId: string; quote: string; sourceUrl: string }[];
  reasoning: string;
  applicationText: string | null;
}
export interface ReviewAnalysis {
  assessments: ReviewAssessment[];
  questions: { itemId: string; question: string; impact: string; factIds: string[] }[];
  summary: string;
}
export interface ReviewExport {
  id: string; mode: 'draft' | 'complete'; path: string; previewPath: string;
  sourceRevision: number; generatedAt: string; stale: boolean;
}
export interface ReviewRecord {
  intake: ReviewIntake;
  intakeRevision: number;
  analysis: ReviewAnalysis | null;
  analysisStatus: 'not_started' | 'current' | 'stale';
  analysisRevision: number | null;
  exports: ReviewExport[];
}
const text: Spec = { type: 'string', minLength: 1, maxLength: 20000 };
const id: Spec = { type: 'string', pattern: /^[A-Za-z0-9_.:-]{1,120}$/ };
const nullable = (s: Spec): Spec => ({ oneOf: [s, { type: 'null' }] });
const date: Spec = { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/ };
const en = (...values: string[]): Spec => ({ type: 'string', enum: values });
const obj = (properties: Record<string, Spec>): Spec => ({ type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, { ...v, required: true }])) });
const arr = (items: Spec, maxItems = 100, minItems = 0): Spec => ({ type: 'array', items, maxItems, minItems });
const refs = arr(id);
export const reviewIntakeSpec = obj({
  applicant: obj({ kind: en('individual', 'organization'), name: nullable(text), identityNumber: nullable(text), address: nullable(text), phone: nullable(text), details: nullable(text), representative: nullable(text) }),
  original: obj({ number: nullable(text), authority: nullable(text), issuedOn: nullable(date), servedOn: nullable(date), source: text, text: { ...text, maxLength: 200000 }, conclusions: arr(obj({ id, locator: text, quote: text, responsibility: nullable(text) }), 100, 1) }),
  accidentSummary: nullable(text), userRequest: nullable(text), receivingAuthority: nullable(text), applicationDate: nullable(date), priorReview: en('none', 'submitted', 'concluded', 'unknown'),
  evidence: arr(obj({ id, title: text, source: text, locator: text, quote: text, availability: en('available', 'to_obtain') })),
});
export const reviewAnalysisSpec = obj({
  assessments: arr(obj({ id, category: en(...reviewCategories), status: en('supported', 'pending', 'insufficient'), originalConclusionIds: arr(id, 100, 1), evidenceIds: refs, factIds: refs, legalRefs: arr(obj({ ruleId: id, quote: text, sourceUrl: text }), 12, 1), reasoning: text, applicationText: nullable(text) }), 60, 6),
  questions: arr(obj({ itemId: id, question: text, impact: text, factIds: refs }), 20), summary: text,
});

export function invalidateReview(record: CaseRecord) {
  if (!record.review) return;
  if (record.review.analysis) record.review.analysisStatus = 'stale';
  for (const file of record.review.exports) file.stale = true;
}

/** Stable field paths also form question IDs and prevent model inference from prose answers. */
export const reviewFields = [
  ['original.servedOn', '认定书送达日期', '请填写认定书实际送达日期（YYYY-MM-DD）；不清楚可直接说明。', '申请期限为送达之日起三个工作日，不能按作出日期代替。'],
  ['priorReview', '既往复核情况', '本事故是否已经申请过复核？请回答 none（未申请）、submitted（已提交）或 concluded（已有结论）；不清楚可直接说明。', '同一事故复核一次，须先核对既往申请。'],
  ['applicant.name', '申请人姓名或名称'], ['applicant.identityNumber', '身份证号或统一社会信用代码'],
  ['applicant.address', '申请人地址'], ['applicant.phone', '联系电话'],
  ['original.number', '认定书编号'], ['original.authority', '原认定机关'], ['original.issuedOn', '认定书作出日期'],
  ['receivingAuthority', '上一级公安机关交通管理部门名称'], ['applicationDate', '拟申请日期'],
  ['accidentSummary', '事故基本经过'], ['userRequest', '申请人具体复核请求'],
] as const;
export function intakeField(intake: ReviewIntake, field: string): unknown {
  const [parent, child] = field.split('.');
  return child ? (intake[parent as 'applicant' | 'original'] as unknown as Record<string, unknown>)[child] : intake[field as keyof ReviewIntake];
}
export function reviewMissing(record: CaseRecord): string[] {
  if (!record.review) return ['复核资料'];
  const intake = record.review.intake;
  const missing: string[] = reviewFields.filter(([field]) => !intakeField(intake, field) || intakeField(intake, field) === 'unknown').map(([, label]) => label);
  if (intake.applicant.kind === 'organization' && !intake.applicant.representative) missing.push('法定代表人');
  if (!intake.original.conclusions.some((c) => c.responsibility)) missing.push('原责任结论');
  if (record.review.analysisStatus !== 'current') missing.push('有效复核分析');
  if (!record.review.analysis?.assessments.some((a) => a.status === 'supported')) missing.push('有依据的复核理由');
  if (!intake.evidence.some((e) => e.availability === 'available')) missing.push('可提交的主要证据');
  return missing;
}
export function reviewQuestions(record: CaseRecord): CaseQuestion[] {
  if (!record.review) return [];
  const intake = record.review.intake;
  const result: CaseQuestion[] = reviewFields.filter(([field]) => !intakeField(intake, field) || intakeField(intake, field) === 'unknown').map(([field, label, question, impact]) => ({
    itemId: `review.field.${field}`, question: question ?? `请补充${label}${field.endsWith('On') || field === 'applicationDate' ? '（YYYY-MM-DD）' : ''}；不清楚可直接说明。`,
    impact: impact ?? `用于复核申请书的${label}，未知时只能保留草稿占位符。`, severity: 'blocking', partyId: null, factIds: [], stages: [], target: 'review_intake',
  }));
  if (intake.applicant.kind === 'organization' && !intake.applicant.representative) result.push({ itemId: 'review.field.applicant.representative', question: '请补充法定代表人姓名及职务。', impact: '用于组织申请人信息。', severity: 'blocking', partyId: null, factIds: [], stages: [], target: 'review_intake' });
  // Factual questions survive invalidation until the user reply has entered evidence review.
  for (const q of record.review.analysis?.questions ?? []) result.push({ ...q, severity: 'conditional', partyId: null, stages: [], target: 'fact' });
  return result;
}
export function applyReviewAnswer(record: CaseRecord, answer: QuestionAnswer) {
  if (answer.questionRecord.target !== 'review_intake' || !record.review) return;
  const field = answer.itemId.replace(/^review\.field\./, '');
  const allowed = [...reviewFields.map(([f]) => f), 'applicant.representative'];
  if (!allowed.includes(field)) throw new Error(`不支持的复核资料字段：${field}`);
  const value = reviewAnswerValue(answer);
  const [parent, child] = field.split('.');
  if (child) (record.review.intake[parent as 'applicant' | 'original'] as unknown as Record<string, unknown>)[child] = value;
  else (record.review.intake as unknown as Record<string, unknown>)[field] = value;
  const errors = validate(reviewIntakeSpec, record.review.intake);
  if (errors.length) throw new Error(`复核资料回答格式不合法：${errors.join('；')}`);
  for (const day of [record.review.intake.original.issuedOn, record.review.intake.original.servedOn, record.review.intake.applicationDate]) checkReviewDate(day);
  if (record.review.intake.original.issuedOn && record.review.intake.original.servedOn && record.review.intake.original.servedOn < record.review.intake.original.issuedOn) throw new Error('送达日期不能早于认定书作出日期');
  record.review.intakeRevision = record.revision + 1;
  invalidateReview(record);
}
export function reviewAnswerValue(answer: QuestionAnswer) {
  return answer.status === 'unknown'
    ? (answer.itemId === 'review.field.priorReview' ? 'unknown' : null)
    : answer.answer.trim();
}
export function checkReviewDate(value: string | null) {
  if (value && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new Error(`无效日期：${value}`);
}
export const reviewGuidance = '依据《道路交通事故处理程序规定》第七十一条、第一百一十二条，复核申请期限为送达之日起三个工作日，同一事故复核一次；可经原认定机关或直接向上一级公安机关交通管理部门提出（第七十二条）。本工具不计算含节假日调休的截止日期，请及时核实提交时间并保留凭证。';
export function reviewView(record: CaseRecord) {
  if (!record.review) return null;
  return { ...record.review, missing: reviewMissing(record), guidance: reviewGuidance, eligibility: record.review.intake.priorReview === 'none' ? 'needs_deadline_check' : record.review.intake.priorReview === 'unknown' ? 'unknown' : 'prior_review_recorded' };
}
