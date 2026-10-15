import type { LawLibrary } from '../src/laws.ts';
import { reviewCategories, type ReviewAnalysis, type ReviewIntake } from '../src/review-model.ts';

/** Synthetic procedural objection; it does not assume an alternative responsibility level. */
export const intake: ReviewIntake = {
  applicant: { kind: 'individual', name: '示例申请人', identityNumber: '示例证件号', address: '示例市示例路', phone: '示例联系电话', details: null, representative: null },
  original: {
    number: '示例认字第001号', authority: '示例市公安局交通警察大队', issuedOn: '2026-10-12', servedOn: '2026-10-13',
    source: '用户提供的示例认定书', text: '事故地点：示例路口。责任认定：甲承担全部责任，乙无责任。',
    conclusions: [{ id: 'original_1', locator: '第1页责任认定段', quote: '甲承担全部责任，乙无责任', responsibility: '甲全部责任、乙无责任' }],
  },
  accidentSummary: '示例车辆在路口发生接触。具体事故事实应结合实际材料核对',
  userRequest: '请核查认定书的证据及事故原因记载，依法审查并责令重新调查、认定',
  receivingAuthority: '示例市公安局交通警察支队', applicationDate: '2026-10-14', priorReview: 'none',
  evidence: [{ id: 'doc_copy', title: '原事故认定书完整复印件', source: '用户提供', locator: '全文', quote: '事故地点：示例路口。责任认定：甲承担全部责任，乙无责任。', availability: 'available' }],
};
export function analysis(lib: LawLibrary): ReviewAnalysis {
  const rule = lib.byId.get('accident_procedure_article_64')!.rule;
  return {
    summary: '核对认定书是否完整记载主要证据及事故形成原因；其他方面现有资料不足以支持异议',
    assessments: reviewCategories.map((category) => ({
      id: `review_${category}`, category, status: category === 'procedure' ? 'supported' : 'insufficient', originalConclusionIds: ['original_1'], evidenceIds: ['doc_copy'], factIds: [],
      legalRefs: [{ ruleId: rule.id, quote: rule.text, sourceUrl: rule.sourceUrl }],
      reasoning: category === 'procedure' ? '示例原认定书全文未见证据及事故形成原因记载，须核实该遗漏是否影响责任认定' : '现有材料不足以支持这一方面的异议，不能推断申请人应承担较轻责任',
      applicationText: category === 'procedure' ? '原认定书全文未载明事故证据及形成原因分析，无法核对由哪些主要证据得出责任结论。该遗漏可能影响事故认定，申请人请求依法审查并核实相关证据和成因分析。' : null,
    })), questions: [],
  };
}
