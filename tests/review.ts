/** Behavioral integration checks for official review, persisted answers, revisions and OOXML. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { CaseStore, readCase, recordAnswers, submitStage } from '../src/engine.ts';
import { loadLawLibrary, readRules, searchLaw } from '../src/laws.ts';
import { exportReview, saveReview } from '../src/review.ts';
import { intake, analysis } from './review-fixtures.ts';

const lib = loadLawLibrary(join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'laws'));
const directory = mkdtempSync(join(tmpdir(), 'traffic-review-'));
const store = new CaseStore(directory);
const save = (caseId?: string, payload = structuredClone(intake)) => saveReview(store, lib, { caseId, section: 'intake', payload });
const saveAnalysis = (caseId: string, payload = analysis(lib)) => saveReview(store, lib, { caseId, section: 'analysis', payload });

try {
  assert.equal(lib.rules.filter((r) => r.title === '道路交通事故处理程序规定').length, 114);
  assert.equal(searchLaw(lib, { query: '道路交通事故处理程序规定第七十一条', occurredAt: '2017-01-01', asOf: '2026-10-14' }).status, 'matched');
  assert.equal(searchLaw(lib, { query: '道路交通事故处理程序规定第七十一条', asOf: '2017-01-01' }).status, 'version_not_covered');
  assert.equal(searchLaw(lib, { query: 'accident_procedure_article_71', asOf: '2017-01-01' }).status, 'version_not_covered');
  assert.throws(() => searchLaw(lib, { asOf: '2026-02-30' }), /有效/);
  assert.equal(searchLaw(lib, { lawId: 'road_traffic_accident_procedures', articleNumber: 71 }).cards[0].annotation, 'verified');
  assert.match(JSON.stringify(readRules(lib, ['accident_procedure_article_112'])), /工作日/);

  const forged = structuredClone(intake);
  forged.original.conclusions[0].quote = '伪造的原认定内容';
  assert.throws(() => save(undefined, forged), /引文不在原文/);
  assert.equal(store.list().length, 0, '验证失败不创建空案件');
  const malformedDate = structuredClone(intake);
  malformedDate.original.servedOn = '2026-02-30';
  assert.throws(() => save(undefined, malformedDate), /无效日期/);

  const caseId = save().caseId;
  assert.equal(readCase(store, lib, caseId).adoptedFacts.length, 0, '原认定书不自动变成事实');
  assert.equal(store.get(caseId).stages.registration.status, 'not_started', '直接导入可独立复核');
  const partial = analysis(lib); partial.assessments.pop();
  assert.throws(() => saveAnalysis(caseId, partial), /至少 6/);
  const invalidRef = analysis(lib); invalidRef.assessments[0].originalConclusionIds = ['missing'];
  assert.throws(() => saveAnalysis(caseId, invalidRef), /原认定结论/);
  const invalidLaw = analysis(lib); invalidLaw.assessments[0].legalRefs[0].quote = '不存在的法条原文';
  assert.throws(() => saveAnalysis(caseId, invalidLaw), /引文或来源/);
  const unavailable = structuredClone(intake); unavailable.evidence[0].availability = 'to_obtain';
  save(caseId, unavailable);
  assert.throws(() => saveAnalysis(caseId), /尚未取得/);
  save(caseId);
  const noGrounds = analysis(lib);
  noGrounds.assessments.forEach((a) => { a.status = 'insufficient'; a.applicationText = null; });
  saveAnalysis(caseId, noGrounds);
  await assert.rejects(exportReview(store, lib, caseId, 'complete'), /有依据的复核理由/);
  const noGroundsDraft = await exportReview(store, lib, caseId, 'draft');
  assert.match(noGroundsDraft.preview, /依据不足/);
  assert.ok(!noGroundsDraft.preview.includes('原认定书全文未载明'));

  saveAnalysis(caseId);
  const complete = await exportReview(store, lib, caseId, 'complete');
  const zip = await JSZip.loadAsync(readFileSync(complete.path));
  const xml = await zip.file('word/document.xml')!.async('string');
  const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const texts = [...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(([p]) => [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>/g)].map((m) => m[1] === undefined ? '\n' : decode(m[1])).join(''));
  assert.equal(texts.join('\n\n'), complete.preview, 'Word 与文字预览完全一致');
  assert.equal(readFileSync(complete.previewPath, 'utf8'), complete.preview);
  assert.ok(!complete.preview.includes('【待补充：'));
  assert.ok(!complete.preview.includes('三日内提出'), '不虚构按时提交');
  assert.match(complete.preview, /本人签名或盖章/);
  assert.match(complete.guidance, /三个工作日/);
  const second = await exportReview(store, lib, caseId, 'complete');
  assert.notEqual(second.path, complete.path, '每次导出独立文件，不覆盖旧文书');

  const incomplete = structuredClone(intake);
  incomplete.original.servedOn = null; incomplete.priorReview = 'unknown'; incomplete.applicant.phone = null;
  save(caseId, incomplete);
  const clarification = readCase(store, lib, caseId).clarification;
  assert.equal(clarification.status, 'limited');
  assert.equal(clarification.pendingIntakeCount, 3);
  assert.equal(clarification.pendingBlockingCount, 0);
  assert.equal(clarification.pendingFactCount, 0);
  const questions = clarification.questions;
  assert.deepEqual(questions.map((q) => q.itemId), ['review.field.original.servedOn', 'review.field.priorReview', 'review.field.applicant.phone']);
  assert.ok(store.get(caseId).review!.exports.every((e) => e.stale));
  const revision = store.get(caseId).revision;
  assert.throws(() => recordAnswers(store, caseId, [
    { itemId: 'review.field.applicant.phone', status: 'answered', answer: '示例电话', speaker: '甲' },
    { itemId: 'review.field.original.servedOn', status: 'answered', answer: '2026-02-30', speaker: '甲' },
  ]), /无效日期/);
  assert.equal(store.get(caseId).revision, revision, '资料回答批次失败无部分写入');
  recordAnswers(store, caseId, [{ itemId: 'review.field.original.servedOn', status: 'unknown', answer: '不清楚', speaker: '甲' }]);
  assert.ok(!readCase(store, lib, caseId).clarification.questions.some((q) => q.itemId === 'review.field.original.servedOn'));
  recordAnswers(store, caseId, [
    { itemId: 'review.field.applicant.phone', status: 'answered', answer: '示例电话', speaker: '甲' },
    { itemId: 'review.field.priorReview', status: 'answered', answer: 'none', speaker: '甲' },
  ]);
  assert.equal(store.get(caseId).review!.intake.applicant.phone, '示例电话');
  assert.equal(readCase(store, lib, caseId).evidenceForUpdate, null, '文书回答不进入事故证据草稿');
  const draft = await exportReview(store, lib, caseId, 'draft');
  assert.match(draft.preview, /【待补充：实际送达日期】/);
  assert.match(draft.preview, /须重新复核分析/);
  await assert.rejects(exportReview(store, lib, caseId, 'complete'), /送达日期/);
  recordAnswers(store, caseId, [{ itemId: 'review.field.original.servedOn', status: 'answered', answer: '2026-10-13', speaker: '甲' }]);
  saveAnalysis(caseId);
  assert.equal(store.get(caseId).review!.analysisStatus, 'current');
  const alreadyReviewed = structuredClone(intake); alreadyReviewed.priorReview = 'concluded';
  save(caseId, alreadyReviewed); saveAnalysis(caseId);
  await assert.rejects(exportReview(store, lib, caseId, 'complete'), /已申请复核/);
  assert.match((await exportReview(store, lib, caseId, 'draft')).preview, /同一事故复核一次/);

  // Existing evidence facts, including contrary material, must constrain supported objections.
  save(caseId);
  submitStage(store, lib, { caseId, stage: 'registration', payload: { occurredAt: '2026-10-10', reportedAt: null, location: '示例路口', jurisdiction: '全国', roadType: null, intersectionType: null, trafficControl: null, casualties: null, propertyLoss: null, unknowns: [], parties: [{ id: 'A', name: '甲', role: 'motor_driver' }], vehicles: [] } });
  submitStage(store, lib, { caseId, stage: 'evidence', payload: { skippedReason: 'no_materials', materials: [], observations: [], qualityIssues: [], facts: [{ id: 'signal', proposition: '信号灯颜色', status: 'unknown', supportingObservationIds: [], opposingObservationIds: [] }] } });
  const evidenceBeforeMetadata = structuredClone(store.get(caseId).stages.evidence);
  const resetPhone = structuredClone(intake); resetPhone.applicant.phone = null;
  save(caseId, resetPhone);
  recordAnswers(store, caseId, [{ itemId: 'review.field.applicant.phone', status: 'answered', answer: '示例电话', speaker: '甲' }]);
  assert.equal(store.get(caseId).review!.intake.applicant.phone, '示例电话', '资料被清空后，同一历史回答仍须恢复字段');
  assert.deepEqual(store.get(caseId).stages.evidence, evidenceBeforeMetadata, '资料回答保留已有的事实分析及其有效状态');
  assert.equal(readCase(store, lib, caseId).evidenceForUpdate, null);
  const pending = analysis(lib);
  pending.assessments[0].status = 'pending'; pending.assessments[0].factIds = ['signal'];
  pending.questions.push({ itemId: 'review.signal', question: '当时面对的信号灯是什么颜色？', impact: '影响对通行义务及原认定的核对', factIds: ['signal'] });
  saveAnalysis(caseId, pending);
  const disputed = structuredClone(pending); disputed.assessments[0].status = 'supported'; disputed.assessments[0].applicationText = '信号灯为绿灯';
  assert.throws(() => saveAnalysis(caseId, disputed), /未知或争议事实/);
  const fabricatedFact = analysis(lib); fabricatedFact.assessments[0].factIds = ['made_up'];
  assert.throws(() => saveAnalysis(caseId, fabricatedFact), /不存在或失效的事实/);
  const prematureLiability = analysis(lib); prematureLiability.assessments[4].status = 'supported'; prematureLiability.assessments[4].applicationText = '申请人应承担次要责任';
  assert.throws(() => saveAnalysis(caseId, prematureLiability), /六阶段/);
  const factReply = recordAnswers(store, caseId, [{ itemId: 'review.signal', status: 'answered', answer: '当时绿灯', speaker: '甲' }]);
  assert.equal(store.get(caseId).review!.analysisStatus, 'stale');
  assert.equal(store.get(caseId).stages.evidence.status, 'stale');
  assert.equal(factReply.evidenceForUpdate!.observations.at(-1)!.content, '当时绿灯');
  assert.equal(factReply.evidenceForUpdate!.observations.at(-1)!.speaker, '甲');
  assert.equal(new CaseStore(directory).get(caseId).questionAnswers!.at(-1)!.answer, '当时绿灯', '重启恢复原话');
  await assert.rejects(exportReview(store, lib, caseId, 'complete'), /有效复核分析/);
  const staleDraft = await exportReview(store, lib, caseId, 'draft');
  assert.ok(!staleDraft.preview.includes('原认定书全文未载明'), '过期分析不进入新草稿');
  const conflict = readCase(store, lib, caseId).evidenceForUpdate!;
  conflict.materials.push({ id: 'video', title: '示例路口影像', kind: 'video', source: '用户提供' });
  conflict.observations.push({ id: 'red_signal', materialId: 'video', locator: '00:02', kind: 'observation', content: '面对信号灯为红灯', speaker: null, partyIds: ['A'], vehicleIds: [], timeRange: null, issue: '与补充回答冲突' });
  conflict.facts[0].status = 'disputed';
  conflict.facts[0].supportingObservationIds = [conflict.observations[0].id];
  conflict.facts[0].opposingObservationIds = ['red_signal'];
  conflict.facts[0].visualChecks = [{ materialId: 'video', result: 'conflict', observationIds: ['red_signal'], reason: '陈述绿灯与影像红灯不一致' }];
  const wronglyAdopted = structuredClone(conflict); wronglyAdopted.facts[0].status = 'supported';
  assert.throws(() => submitStage(store, lib, { caseId, stage: 'evidence', payload: wronglyAdopted }), /与影像冲突/);
  submitStage(store, lib, { caseId, stage: 'evidence', payload: conflict });
  assert.throws(() => saveAnalysis(caseId, disputed), /未知或争议事实/);
  saveAnalysis(caseId, pending);
  await assert.rejects(exportReview(store, lib, caseId, 'complete'), /待核实的复核意见/);
  assert.equal(readCase(store, lib, caseId).clarification.pendingCount, 0, '用户已回答的争议事实不反复追问');
  assert.equal(readCase(store, lib, caseId).adoptedFacts.length, 0, '补充回答不能覆盖相反影像');
  const legacy = store.create('旧案件', lib.catalog.version);
  assert.equal(readCase(store, lib, legacy.id).review, null);
  console.log('review ok: official laws, intake, citation checks, question routing, immutable exports, OOXML parity, stale results, legacy cases');
} finally { rmSync(directory, { recursive: true, force: true }); }
