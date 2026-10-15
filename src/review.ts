/** Validated review intake/analysis and immutable, versioned local exports. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CaseStore, type CaseRecord } from './engine.ts';
import { normalize, ruleInForce, type LawLibrary } from './laws.ts';
import { clarificationFor, latestAnswers } from './questions.ts';
import { validate, type Causation, type EvidenceAnalysis, type Liability, type Registration } from './schema.ts';
import { applicationContent, renderApplication } from './review-document.ts';
import { checkReviewDate, invalidateReview, reviewAnalysisSpec, reviewCategories, reviewIntakeSpec, reviewMissing, reviewView, type ReviewAnalysis, type ReviewIntake, type ReviewExport } from './review-model.ts';

const ensure: (value: unknown, message: string) => asserts value = (value, message) => { if (!value) throw new Error(message); };
const unique = (ids: string[], label: string) => ensure(new Set(ids).size === ids.length, `${label} ID 重复`);
const usable = (record: CaseRecord, stage: keyof CaseRecord['stages']) => ['analyzed', 'needs_investigation'].includes(record.stages[stage].status);

function validateIntake(intake: ReviewIntake) {
  for (const date of [intake.original.issuedOn, intake.original.servedOn, intake.applicationDate]) checkReviewDate(date);
  unique(intake.original.conclusions.map((c) => c.id), '原认定结论');
  unique(intake.evidence.map((e) => e.id), '复核证据');
  for (const c of intake.original.conclusions) ensure(intake.original.text.includes(c.quote), `原认定结论 ${c.id} 引文不在原文中`);
  if (intake.original.issuedOn && intake.original.servedOn) ensure(intake.original.servedOn >= intake.original.issuedOn, '送达日期不能早于认定书作出日期');
}

function validateAnalysis(record: CaseRecord, lib: LawLibrary, analysis: ReviewAnalysis) {
  const intake = record.review!.intake;
  const evidence = usable(record, 'evidence') ? record.stages.evidence.payload as EvidenceAnalysis : null;
  const reg = record.stages.registration.payload as Registration | null;
  unique(analysis.assessments.map((a) => a.id), '复核意见');
  unique(analysis.questions.map((q) => q.itemId), '复核补问');
  for (const category of reviewCategories) ensure(analysis.assessments.some((a) => a.category === category), `复核分析缺少审查方面：${category}`);
  for (const q of analysis.questions) {
    ensure(!q.itemId.startsWith('review.field.'), '事故事实补问不能使用 review.field. 文书资料前缀');
    for (const id of q.factIds) ensure(evidence?.facts.some((f) => f.id === id), `复核补问引用不存在或失效的事实：${id}`);
  }
  for (const a of analysis.assessments) {
    for (const id of a.originalConclusionIds) ensure(intake.original.conclusions.some((c) => c.id === id), `复核意见 ${a.id} 引用不存在的原认定结论：${id}`);
    for (const id of a.evidenceIds) {
      const source = intake.evidence.find((e) => e.id === id);
      ensure(source, `复核意见 ${a.id} 引用不存在的证据：${id}`);
      ensure(a.status !== 'supported' || source.availability === 'available', `复核意见 ${a.id} 依赖尚未取得的证据，只能待核实`);
    }
    for (const id of a.factIds) {
      const fact = evidence?.facts.find((f) => f.id === id);
      ensure(fact, `复核意见 ${a.id} 引用不存在或失效的事实：${id}`);
      ensure(a.status !== 'supported' || fact.status === 'supported', `复核意见 ${a.id} 依赖未知或争议事实，只能待核实`);
    }
    for (const ref of a.legalRefs) {
      const entry = lib.byId.get(ref.ruleId);
      ensure(entry, `复核引用的法规不在法规库中：${ref.ruleId}`);
      ensure(entry.rule.sourceUrl === ref.sourceUrl && normalize(ref.quote).length >= 8 && normalize(entry.rule.text).includes(normalize(ref.quote)), `复核法规 ${ref.ruleId} 引文或来源不匹配`);
      const when = entry.lawId === 'road_traffic_accident_procedures' ? intake.applicationDate : reg?.occurredAt ?? null;
      ensure(!ruleInForce(entry.rule, when, reg?.jurisdiction ?? '全国'), `复核法规 ${ref.ruleId} 在核对时点或地区不适用`);
    }
    if (a.status === 'supported') {
      ensure(a.applicationText, `有依据的复核意见 ${a.id} 须提供申请书理由正文`);
      ensure(a.evidenceIds.length > 0 || a.factIds.length > 0 || a.category === 'procedure', `复核意见 ${a.id} 缺少证据或已采纳事实`);
      if (a.category === 'causation' || a.category === 'liability') {
        ensure(['registration', 'evidence', 'duties', 'faults', 'causation', 'liability'].every((s) => usable(record, s as keyof CaseRecord['stages'])), '重新评价因果作用或责任划分前须完成有效的六阶段分析');
        if (a.category === 'liability') ensure((record.stages.liability.payload as Liability).recommendationType === 'supported', '原责任建议仍有条件或暂无法判断，责任复核只能待核实');
        else ensure((record.stages.causation.payload as Causation).analyses.some((c) => c.conclusion === 'supported'), '因果作用尚无有依据结论，因果复核只能待核实');
      }
    } else ensure(a.applicationText === null, `待核实或依据不足的意见 ${a.id} 不得写成确定申请理由，applicationText 应为 null`);
  }
}

export function saveReview(store: CaseStore, lib: LawLibrary, input: { caseId?: string; section: 'intake' | 'analysis'; payload: unknown }) {
  ensure(['intake', 'analysis'].includes(input.section), 'section 必须是 intake 或 analysis');
  const errors = validate(input.section === 'intake' ? reviewIntakeSpec : reviewAnalysisSpec, input.payload);
  ensure(!errors.length, `复核${input.section === 'intake' ? '资料' : '分析'}结构不合法：${errors.slice(0, 12).join('；')}`);
  if (input.section === 'intake') validateIntake(input.payload as ReviewIntake);
  ensure(input.caseId || input.section === 'intake', '保存复核分析必须提供 caseId');
  const record = input.caseId ? store.get(input.caseId) : store.create('事故认定复核', lib.catalog.version);
  if (input.section === 'intake') {
    const intake = structuredClone(input.payload) as ReviewIntake;
    if (record.review && JSON.stringify(record.review.intake) === JSON.stringify(intake)) return { saved: true, caseId: record.id, review: reviewView(record), clarification: clarificationFor(record) };
    invalidateReview(record);
    record.review = record.review ? { ...record.review, intake, intakeRevision: record.revision + 1 } : {
      intake, intakeRevision: record.revision + 1, analysis: null, analysisStatus: 'not_started', analysisRevision: null, exports: [],
    };
  } else {
    ensure(record.review, '请先保存原事故认定书及复核资料');
    const analysis = structuredClone(input.payload) as ReviewAnalysis;
    validateAnalysis(record, lib, analysis);
    invalidateReview(record);
    record.review.analysis = analysis;
    record.review.analysisStatus = 'current';
    record.review.analysisRevision = record.revision + 1;
  }
  store.save(record);
  return { saved: true, caseId: record.id, review: reviewView(record), clarification: clarificationFor(record) };
}

/** All full-document blockers are reported together; draft export always remains possible. */
export function exportBlockers(record: CaseRecord, lib: LawLibrary): string[] {
  const missing = reviewMissing(record);
  const review = record.review;
  if (!review) return missing;
  if (review.intake.priorReview !== 'none') missing.push('同一事故已申请复核或既往申请状态未知，须核实受理条件');
  if (review.intake.applicationDate && review.intake.original.servedOn && review.intake.applicationDate < review.intake.original.servedOn) missing.push('拟申请日期早于实际送达日期，须核实');
  if (review.analysisStatus === 'current') {
    if (review.analysis!.assessments.some((a) => a.status === 'pending')) missing.push('待核实的复核意见');
    const pending = latestAnswers(record).filter((a) => a.appliedAtRevision === null);
    if (pending.length || clarificationFor(record, true).pendingCount > 0) missing.push('待补充或待重审的事故事实');
    const reg = record.stages.registration.payload as Registration | null;
    for (const a of review.analysis!.assessments.filter((a) => a.status === 'supported')) {
      for (const ref of a.legalRefs) if (lib.byId.get(ref.ruleId)?.lawId !== 'road_traffic_accident_procedures' && !reg?.occurredAt) missing.push('通行规则适用时点所需的事故日期');
    }
    if (review.intake.userRequest && /(?:全部|主要|同等|次要|无)责任/.test(review.intake.userRequest) && !review.analysis!.assessments.some((a) => a.category === 'liability' && a.status === 'supported')) missing.push('具体责任等级请求缺少六阶段分析及有依据的责任复核意见');
  }
  return [...new Set(missing)];
}

export async function exportReview(store: CaseStore, lib: LawLibrary, caseId: string, mode: 'draft' | 'complete') {
  ensure(mode === 'draft' || mode === 'complete', 'mode 必须是 draft 或 complete');
  const record = store.get(caseId);
  ensure(record.review, '请先保存复核资料');
  const missing = exportBlockers(record, lib);
  ensure(mode !== 'complete' || missing.length === 0, `尚不能生成完整申请书：${missing.join('；')}。请使用 draft 生成草稿并补充资料。`);
  const content = applicationContent(record, lib, mode);
  const buffer = await renderApplication(content, mode);
  // Generation is asynchronous: re-read before committing to avoid publishing an obsolete snapshot.
  const current = store.get(caseId);
  ensure(current.revision === record.revision, '生成期间案件已更新，请重新导出');
  const id = randomUUID();
  const dir = resolve(store.dir, 'exports', caseId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stem = `${mode === 'draft' ? '复核申请书草稿' : '复核申请书待签版'}-r${record.revision}-${id}`;
  const path = join(dir, `${stem}.docx`);
  const previewPath = join(dir, `${stem}.txt`);
  const preview = content.map((p) => p.text).join('\n\n');
  try {
    writeFileSync(`${path}.tmp`, buffer, { mode: 0o600, flag: 'wx' });
    writeFileSync(`${previewPath}.tmp`, preview, { mode: 0o600, flag: 'wx' });
    renameSync(`${path}.tmp`, path);
    renameSync(`${previewPath}.tmp`, previewPath);
    const generated: ReviewExport = { id, mode, path, previewPath, sourceRevision: record.revision, generatedAt: new Date().toISOString(), stale: false };
    current.review!.exports.push(generated);
    store.save(current);
    return { ...generated, preview, missing, guidance: reviewView(current)!.guidance, delivery: '请用宿主 present 工具展示 path 指向的 Word 文件；签名区由申请人本人填写并提交。' };
  } catch (error) {
    for (const file of [path, previewPath, `${path}.tmp`, `${previewPath}.tmp`]) rmSync(file, { force: true });
    throw error;
  }
}
