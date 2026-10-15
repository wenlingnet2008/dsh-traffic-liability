/** Generate an empty reusable template and synthetic samples for visual QA. */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseStore } from '../src/engine.ts';
import { loadLawLibrary } from '../src/laws.ts';
import { exportReview, saveReview } from '../src/review.ts';
import { intake, analysis } from '../tests/review-fixtures.ts';

const output = resolve(process.argv[2] ?? '/tmp/traffic-review-visual-qa');
mkdirSync(output, { recursive: true });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = loadLawLibrary(join(root, 'data', 'laws'));
const cases = mkdtempSync(join(tmpdir(), 'traffic-review-samples-'));
const store = new CaseStore(cases);
try {
  const blank = structuredClone(intake);
  blank.applicant = { kind: 'individual', name: null, identityNumber: null, address: null, phone: null, details: null, representative: null };
  blank.original = { number: null, authority: null, issuedOn: null, servedOn: null, source: '【待补充：原认定书来源】', text: '【待补充：原认定书原文及责任结论】', conclusions: [{ id: 'original', locator: '【待补充：原文页码或段落】', quote: '【待补充：原认定书原文及责任结论】', responsibility: null }] };
  blank.accidentSummary = null; blank.userRequest = null; blank.receivingAuthority = null;
  blank.applicationDate = null; blank.priorReview = 'unknown'; blank.evidence = [];
  const templateCase = saveReview(store, lib, { section: 'intake', payload: blank }).caseId;
  const template = await exportReview(store, lib, templateCase, 'draft');
  copyFileSync(template.path, join(output, '道路交通事故认定复核申请书模板.docx'));
  copyFileSync(template.previewPath, join(output, '道路交通事故认定复核申请书模板.txt'));
  for (const size of ['short', 'long']) {
    const caseId = saveReview(store, lib, { section: 'intake', payload: intake }).caseId;
    const review = analysis(lib);
    if (size === 'long') {
      const ground = review.assessments.find((a) => a.category === 'procedure')!;
      ground.applicationText = Array.from({ length: 12 }, (_, i) => `第${i + 1}项示例核对内容：原认定书未载明事故证据及形成原因分析，无法核对由哪些主要证据得出责任结论。申请人请求依法调取现场记录、核实证据之间的对应关系，并说明相关程序问题是否可能影响事故认定。本段仅用于检验中文长文的分页与换行。`).join('\n');
    }
    saveReview(store, lib, { caseId, section: 'analysis', payload: review });
    const document = await exportReview(store, lib, caseId, 'complete');
    copyFileSync(document.path, join(output, `${size}.docx`));
  }
  console.log(output);
} finally { rmSync(cases, { recursive: true, force: true }); }
