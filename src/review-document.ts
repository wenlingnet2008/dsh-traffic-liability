/** One paragraph model feeds both editable OOXML and the exact text preview. */
import { AlignmentType, Document, Packer, Paragraph, TextRun } from 'docx';
import type { CaseRecord } from './engine.ts';
import type { LawLibrary } from './laws.ts';
import type { EvidenceAnalysis } from './schema.ts';
import { reviewLabels } from './review-model.ts';

export interface ApplicationParagraph { kind: 'title' | 'heading' | 'body' | 'signature'; text: string }
const placeholder = (field: string) => `【待补充：${field}】`;
const fill = (value: string | null, field: string) => value ?? placeholder(field);
export function applicationContent(record: CaseRecord, lib: LawLibrary, mode: 'draft' | 'complete'): ApplicationParagraph[] {
  const review = record.review!;
  const intake = review.intake;
  const p = (kind: ApplicationParagraph['kind'], text: string): ApplicationParagraph => ({ kind, text });
  const result: ApplicationParagraph[] = [p('title', '道路交通事故认定复核申请书')];
  if (mode === 'draft') result.push(p('body', '草稿：请核实并补齐标注事项后签署。'));
  const a = intake.applicant;
  result.push(p('body', `申请人：${fill(a.name, '申请人姓名或名称')}。${a.kind === 'organization' ? '统一社会信用代码' : '身份证号'}：${fill(a.identityNumber, '身份证号或统一社会信用代码')}。${a.details ? a.details + '。' : ''}地址：${fill(a.address, '申请人地址')}。联系电话：${fill(a.phone, '联系电话')}。`));
  if (a.kind === 'organization') result.push(p('body', `法定代表人：${fill(a.representative, '法定代表人姓名及职务')}。`));
  result.push(p('body', `原认定机关：${fill(intake.original.authority, '原认定机关')}。原认定书编号：${fill(intake.original.number, '认定书编号')}。作出日期：${fill(intake.original.issuedOn, '认定书作出日期')}。送达日期：${fill(intake.original.servedOn, '实际送达日期')}。`));
  result.push(p('heading', '一 复核请求'));
  result.push(p('body', `请求对上述《道路交通事故认定书》依法进行复核审查；如符合《道路交通事故处理程序规定》第七十六条规定的情形，请依法责令原办案单位重新调查、认定。申请人的具体请求：${fill(intake.userRequest, '具体复核请求')}。`));
  result.push(p('heading', '二 事实与理由'));
  result.push(p('body', `事故基本经过：${fill(intake.accidentSummary, '事故基本经过')}。`));
  result.push(p('body', '原认定书记载：'));
  for (const conclusion of intake.original.conclusions) result.push(p('body', `原文位置：${conclusion.locator}；“${conclusion.quote}”${conclusion.responsibility ? `。原责任结论：${conclusion.responsibility}` : ''}。`));
  const assessments = review.analysisStatus === 'current' ? review.analysis?.assessments ?? [] : [];
  const supported = assessments.filter((a) => a.status === 'supported');
  if (!supported.length) result.push(p('body', placeholder('有来源的复核理由及主要证据')));
  supported.forEach((assessment, i) => {
    result.push(p('heading', `${i + 1} ${reviewLabels[assessment.category]}`));
    result.push(p('body', assessment.applicationText!));
    for (const id of assessment.originalConclusionIds) {
      const c = intake.original.conclusions.find((c) => c.id === id)!;
      result.push(p('body', `对应原认定位置：${c.locator}；“${c.quote}”。`));
    }
    for (const id of assessment.evidenceIds) {
      const e = intake.evidence.find((e) => e.id === id)!;
      result.push(p('body', `主要证据：${e.title}；来源：${e.source}；位置：${e.locator}；摘录：“${e.quote}”。`));
    }
    const evidence = record.stages.evidence.payload as EvidenceAnalysis | null;
    for (const id of assessment.factIds) {
      const fact = evidence!.facts.find((f) => f.id === id)!;
      result.push(p('body', `核对事实：${fact.proposition}。`));
      for (const observationId of fact.supportingObservationIds) {
        const observation = evidence!.observations.find((o) => o.id === observationId)!;
        const material = evidence!.materials.find((m) => m.id === observation.materialId)!;
        result.push(p('body', `事实来源：${material.title}（${material.source}）；位置：${observation.locator}；${observation.kind === 'statement' ? `${observation.speaker}陈述` : '提取内容'}：“${observation.content}”。`));
      }
    }
    for (const ref of assessment.legalRefs) {
      const rule = lib.byId.get(ref.ruleId)!.rule;
      result.push(p('body', `法律依据：《${rule.title}》${rule.article}：“${ref.quote}”。来源：${ref.sourceUrl}`));
    }
  });
  if (mode === 'draft') {
    for (const assessment of assessments.filter((a) => a.status !== 'supported')) result.push(p('body', `${reviewLabels[assessment.category]}${assessment.status === 'pending' ? '待核实' : '现有依据不足'}：${assessment.reasoning}`));
    if (review.analysisStatus === 'stale') result.push(p('body', placeholder('资料已更新，须重新复核分析')));
  }
  result.push(p('heading', '三 主要证据及附件目录'));
  result.push(p('body', '1. 原《道路交通事故认定书》复印件。'));
  const available = intake.evidence.filter((e) => e.availability === 'available');
  available.forEach((e, i) => result.push(p('body', `${i + 2}. ${e.title}（来源：${e.source}；位置：${e.locator}）。`)));
  if (!available.length) result.push(p('body', placeholder('可提交的主要证据材料')));
  result.push(p('body', `${available.length + 2}. 申请人身份证明复印件${a.kind === 'organization' ? '及法定代表人身份证明' : ''}。`));
  // Never assert timely filing: receipt date alone does not prove submission within the legal period.
  result.push(p('body', '申请人依据《道路交通事故处理程序规定》第七十一条提出本申请，请依法审查。'));
  if (mode === 'draft' && intake.priorReview !== 'none') result.push(p('body', `既往复核情况${intake.priorReview === 'unknown' ? '待核实' : '已记录'}：同一事故复核一次，请核实受理条件。`));
  result.push(p('signature', `此致\n${fill(intake.receivingAuthority, '上一级公安机关交通管理部门名称')}`));
  result.push(p('signature', `申请人（本人签名或盖章）：________________\n日期：${fill(intake.applicationDate, '拟申请日期')}`));
  return result;
}

export async function renderApplication(content: ApplicationParagraph[], mode: 'draft' | 'complete'): Promise<Buffer> {
  const paragraphs = content.map((p, index) => new Paragraph({
    ...(p.kind === 'title' ? { style: 'Title', alignment: AlignmentType.CENTER } : {}),
    spacing: { before: p.kind === 'heading' ? 120 : 0, after: 80, line: 300 },
    keepNext: p.kind === 'title' || p.kind === 'heading' || (index >= content.length - 3 && index < content.length - 1),
    keepLines: p.kind === 'signature', widowControl: true,
    children: p.text.split('\n').map((line, i) => new TextRun({ text: line, ...(i ? { break: 1 } : {}), bold: p.kind === 'title' || p.kind === 'heading', size: p.kind === 'title' ? 36 : 24, font: { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: 'SimSun', hint: 'eastAsia' }, language: { value: 'zh-CN', eastAsia: 'zh-CN' }, color: '000000' })),
  }));
  const doc = new Document({
    creator: 'dsh-traffic-liability', title: '道路交通事故认定复核申请书', description: mode === 'draft' ? '复核申请书草稿' : '复核申请书待签版',
    styles: { default: { document: { run: { size: 24, font: { ascii: 'Times New Roman', eastAsia: 'SimSun', hint: 'eastAsia' }, language: { value: 'zh-CN', eastAsia: 'zh-CN' } }, paragraph: { spacing: { line: 300 } } } } },
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children: paragraphs }],
  });
  return Packer.toBuffer(doc);
}
