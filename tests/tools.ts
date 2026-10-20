/** Exercise registered tools and their declared output schemas in source or built mode. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { validateJsonSchemaValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { SubmitResult, readCase, recordAnswers } from '../src/engine.ts';
import { loadLawLibrary, type SearchResult } from '../src/laws.ts';
import type { saveReview, exportReview } from '../src/review.ts';
import { intake, analysis } from './review-fixtures.ts';
import { stages, type stageContracts } from '../src/schema.ts';
import type { validationFailure } from '../src/validation.ts';

type ContractResult = { stageContract: ReturnType<typeof stageContracts> };

const entry = new URL(process.argv.includes('--built') ? '../lib/index.js' : '../src/index.ts', import.meta.url);
const { apply } = await import(entry.href) as typeof import('../src/index.ts');
const directory = mkdtempSync(join(tmpdir(), 'traffic-tools-'));
const tools = new Map<string, ToolDefinition>();
let prompt = '';
const ctx = {
  systemPrompt: { section(value: { text: string }) { prompt = value.text; } },
  tools: { register(tool: ToolDefinition) { tools.set(tool.name, tool); } },
} as unknown as Context;

async function call<T>(name: string, args: unknown): Promise<T> {
  const tool = tools.get(name)!;
  const value = await tool.execute(args, {} as ToolRunContext);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value, 'value'), [], `${name} 输出须符合注册的 schema`);
  return value as T;
}

try {
  apply(ctx, { caseDir: directory, lawDataDir: join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'laws'), promptOrder: 6000 });
  assert.equal(tools.size, 7);
  assert.match(prompt, /traffic_case_answer/);
  assert.match(prompt, /先按六阶段保存现有资料能支持的结果/);
  assert.match(prompt, /申请人姓名、电话、地址等 review_intake 缺项不限制事故定责和复核意见/);
  assert.match(prompt, /文字描述只登记为 statement/);
  assert.deepEqual(validateJsonSchemaValue(tools.get('traffic_case_read')!.parameters, { stage: 'registration' }), []);
  const empty = await call<ContractResult & { cases: unknown[] }>('traffic_case_read', {});
  assert.deepEqual(empty.cases, []);
  assert.ok(!('reviewContract' in empty), '普通列表不加载复核格式');
  assert.deepEqual(Object.keys(empty.stageContract), [...stages]);
  assert.ok(empty.stageContract.registration.requiredFields.includes('parties'));
  assert.ok(Object.values(empty.stageContract).every((contract) => !contract.schema), '列表仅返回阶段摘要');
  const registrationContract = await call<ContractResult>('traffic_case_read', { stage: 'registration' });
  assert.deepEqual(registrationContract, JSON.parse(readFileSync(new URL('./fixtures/registration-contract.json', import.meta.url), 'utf8')));
  for (const stage of stages) {
    const result = await call<ContractResult>('traffic_case_read', { stage });
    assert.deepEqual(Object.keys(result), ['stageContract'], '格式查询不返回案件或其他契约');
    assert.deepEqual(Object.keys(result.stageContract), [stage], '仅加载指定阶段');
    assert.ok(result.stageContract[stage].schema);
    assert.ok(result.stageContract[stage].rules?.length, '业务规则随当前阶段加载');
  }
  assert.deepEqual(await call('traffic_case_read', { caseId: 'not-a-case', stage: 'registration' }), registrationContract, '格式查询不读取案件');
  assert.deepEqual((await call<{ cases: unknown[] }>('traffic_case_read', {})).cases, [], '查询格式不创建案件');
  const rejected = await call<ReturnType<typeof validationFailure>>('traffic_case_save', { stage: 'registration', payload: {} });
  assert.deepEqual(rejected, JSON.parse(readFileSync(new URL('./fixtures/stage-validation-failure.json', import.meta.url), 'utf8')));
  assert.equal(rejected.saved, false);
  assert.equal(rejected.code, 'validation_failed');
  assert.equal(rejected.errors.length, 12);
  assert.equal(rejected.omittedErrors, rejected.totalErrors - rejected.errors.length);
  assert.ok(rejected.errors.some((issue) => issue.path === '$.parties'));
  assert.deepEqual((await call<{ cases: unknown[] }>('traffic_case_read', {})).cases, [], '校验失败不建案');
  const badRegistration = await call<ReturnType<typeof validationFailure>>('traffic_case_save', { stage: 'registration', payload: {
    occurredAt: 'invalid-date', reportedAt: null, location: '路口', jurisdiction: '北京市', roadType: null,
    intersectionType: null, trafficControl: null, casualties: null, propertyLoss: null, unknowns: [],
    parties: [{ id: 'A', name: '甲', role: 'motor_driver' }], vehicles: [],
  } });
  assert.equal(badRegistration.saved, false);
  assert.deepEqual((await call<{ cases: unknown[] }>('traffic_case_read', {})).cases, [], '业务校验失败不建案');
  const created = await call<SubmitResult>('traffic_case_save', {
    stage: 'registration', payload: {
      occurredAt: null, reportedAt: null, location: '路口', jurisdiction: '北京市', roadType: null, intersectionType: null,
      trafficControl: null, casualties: null, propertyLoss: null, unknowns: [],
      parties: [{ id: 'A', name: '甲', role: 'motor_driver' }], vehicles: [],
    },
  });
  const caseId = created.caseId;
  const saved = await call<SubmitResult>('traffic_case_save', {
    caseId, stage: 'evidence', payload: {
      skippedReason: 'no_materials', materials: [], observations: [], qualityIssues: [],
      facts: [{ id: 'signal', proposition: '甲车面对的信号灯颜色', status: 'unknown', supportingObservationIds: [], opposingObservationIds: [] }],
      openQuestions: [{ itemId: 'item.signal', partyId: 'A', prompt: '甲车当时面对的信号灯是什么颜色？', impact: '红灯与绿灯会改变通行义务判断。', factIds: ['signal'] }],
    },
  });
  assert.deepEqual({ status: saved.clarification.status, pendingCount: saved.clarification.pendingCount, pendingBlockingCount: saved.clarification.pendingBlockingCount, pendingConditionalCount: saved.clarification.pendingConditionalCount, pendingIntakeCount: saved.clarification.pendingIntakeCount, questions: saved.clarification.questions }, JSON.parse(readFileSync(new URL('./fixtures/progressive-clarification.json', import.meta.url), 'utf8')));
  assert.match(saved.note, /可先完成附条件的分析或暂无法判断的结果/);
  await assert.rejects(call('traffic_case_answer', { caseId, answers: [{ itemId: 'item.signal', status: 'answered', answer: '绿灯' }] }), /speaker.*缺少/);
  const answered = await call<ReturnType<typeof recordAnswers>>('traffic_case_answer', {
    caseId, answers: [{ itemId: 'item.signal', status: 'answered', answer: '当时面对的是绿灯。', speaker: '甲' }],
  });
  assert.equal(answered.clarification.status, 'needs_reanalysis');
  const view = await call<ReturnType<typeof readCase>>('traffic_case_read', { caseId });
  assert.equal(view.nextStage, 'evidence');
  assert.ok(Object.values(view.stageContract).every((contract) => !contract.schema), '读案不重复返回六阶段详细格式');
  assert.ok(!('reviewContract' in view), '普通读案不加载复核格式');
  const draft = view.evidenceForUpdate!;
  const reply = view.clarification.pendingAnswers[0];
  draft.facts[0].status = 'supported';
  draft.facts[0].supportingObservationIds = [`reply_o_${reply.id}`];
  draft.openQuestions = [];
  const reviewed = await call<SubmitResult>('traffic_case_save', { caseId, stage: 'evidence', payload: draft });
  assert.equal(reviewed.clarification.status, 'complete');
  assert.equal(reviewed.nextStage, 'duties');
  assert.equal((await call<ReturnType<typeof readCase>>('traffic_case_read', { caseId })).adoptedFacts[0].adoptionBasis, 'statement_adopted');
  const lawDataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'laws');
  const lib = loadLawLibrary(lawDataDir);
  const freshReview = await call<ReturnType<typeof saveReview>>('traffic_review_save', { section: 'intake', payload: intake });
  const reviewId = freshReview.caseId;
  const list = await call<{ reviewContract: { intake: unknown } }>('traffic_case_read', { reviewSection: 'intake' });
  assert.ok(list.reviewContract.intake);
  assert.deepEqual(Object.keys(list.reviewContract), ['intake']);
  const analysisFormat = await call<{ reviewContract: { analysis: unknown } }>('traffic_case_read', { reviewSection: 'analysis', caseId: 'missing' });
  assert.deepEqual(Object.keys(analysisFormat.reviewContract), ['analysis']);
  await assert.rejects(call('traffic_case_read', { stage: 'registration', reviewSection: 'intake' }), /只能指定一个/);
  await call('traffic_review_save', { caseId: reviewId, section: 'analysis', payload: analysis(lib) });
  const exported = await call<Awaited<ReturnType<typeof exportReview>>>('traffic_review_export', { caseId: reviewId, mode: 'complete' });
  assert.match(exported.path, /\.docx$/);
  assert.match(exported.preview, /道路交通事故认定复核申请书/);
  assert.match(exported.delivery, /present/);
  const matching = await call<SearchResult>('traffic_rule_search', { lawId: 'road_traffic_accident_procedures', articleNumber: 71, asOf: '2026-10-14' });
  assert.equal(matching.status, 'matched');
  const old = await call<SearchResult>('traffic_rule_search', { lawId: 'road_traffic_accident_procedures', articleNumber: 71, asOf: '2017-01-01' });
  assert.equal(old.status, 'version_not_covered');
  writeFileSync(join(directory, `${caseId}.json`), '{invalid json');
  await assert.rejects(call('traffic_case_save', { caseId, stage: 'evidence', payload: draft }), SyntaxError, '损坏存储不能伪装成普通参数问题');
  console.log(`tools ok: ${process.argv.includes('--built') ? 'built' : 'source'} case/answer lifecycle, official review/export, legal dates, output schemas`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
