/**
 * Traffic accident liability plugin for DeepSeek Harness. Registers the methodology prompt section
 * and seven tools: case read/save, attributed replies, review/export, and law search/read over a verified
 * library. Case files and the law directory are configured per deployment.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import Schema from '@deepseek-ai/schemastery';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseStore, readCase, recordAnswers, submitStage } from './engine.ts';
import { detectLaw, loadLawLibrary, readRules, searchLaw } from './laws.ts';
import { exportReview, saveReview } from './review.ts';
import { reviewIntakeSpec, reviewAnalysisSpec } from './review-model.ts';
import { methodologyText } from './prompt.ts';
import { stages, type Registration } from './schema.ts';

export const name = 'traffic-liability';
export const inject = ['tools', 'systemPrompt'];

export interface Config {
  /** Directory holding rules.json, catalog.json and annotations.json. */
  lawDataDir: string;
  /** Directory where case JSON files are written. */
  caseDir: string;
  /** System prompt section order; external sections may use any finite order. */
  promptOrder: number;
}
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const Config: Schema<Config> = Schema.object({
  lawDataDir: Schema.string().default(join(pluginRoot, 'data', 'laws')),
  caseDir: Schema.string().default(resolve('.traffic-liability')),
  promptOrder: Schema.number().default(6000),
});

const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) => item instanceof RegExp ? item.source : item));
const stageList = stages.join('、');

/**
 * Mount the plugin: load the law library (fails loud when missing), open the case store,
 * contribute the methodology section, and register the seven tools.
 * @param ctx plugin context with `tools` and `systemPrompt` injected
 * @param config validated configuration
 */
export function apply(ctx: Context, config: Config) {
  const lib = loadLawLibrary(config.lawDataDir);
  const store = new CaseStore(config.caseDir);

  ctx.systemPrompt.section({ name: 'traffic-liability:method', order: config.promptOrder, text: methodologyText });

  ctx.tools.register(
    defineTool({
      name: 'traffic_case_read',
      description:
        '读取交通事故案件：登记信息、已采纳事实（adoptedFacts）、有效的上游阶段结果、待补充问题和回答状态（clarification）、待更新的证据草稿（evidenceForUpdate）、各阶段必填字段（stageContract）和法规库摘要。省略 caseId 时返回案件列表。',
      parameters: {
        caseId: { type: 'string', description: '案件 ID；省略时列出全部案件' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!args.caseId) return json({ cases: store.list(), reviewContract: { intake: reviewIntakeSpec, analysis: reviewAnalysisSpec }, note: '用 traffic_case_save 保存 registration 或 traffic_review_save 保存 intake 且不传 caseId 可新建案件' });
        return json(readCase(store, lib, args.caseId));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'traffic_case_save',
      description: `校验并保存一个阶段的结构化结果。阶段顺序：${stageList}，必须按顺序完成。首次保存 registration 时省略 caseId 会新建案件并返回 caseId。payload 是该阶段的对象本身；必填字段见 traffic_case_read 的 stageContract。保存后检查 clarification：关键事实阻断时受影响部分保持暂无法判断；未答的条件性问题不阻止先保存附条件建议，申请资料缺项不阻止事故分析。不得代答，确定建议仍须解决影响判断的事实。结构或引用不合法时返回具体错误，修正后重新保存。`,
      parameters: {
        stage: { type: 'string', enum: stages, required: true, description: '阶段名' },
        payload: { type: 'json', required: true, description: '该阶段的结构化结果对象' },
        caseId: { type: 'string', description: '案件 ID；仅首次保存 registration 时可省略' },
        title: { type: 'string', description: '新建案件时的标题，可省略' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            saved: { type: 'boolean', required: true },
            caseId: { type: 'string', required: true },
            stage: { type: 'string', required: true },
            status: { type: 'string', required: true },
            blockers: { type: 'array', items: { type: 'string' }, required: true },
            nextStage: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
            clarification: { type: 'json', required: true },
            note: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        const result = submitStage(store, lib, {
          stage: args.stage,
          payload: args.payload,
          ...(args.caseId ? { caseId: args.caseId } : {}),
          ...(args.title ? { title: args.title } : {}),
        });
        return {
          saved: result.saved,
          caseId: result.caseId,
          stage: result.stage,
          status: result.status,
          blockers: result.blockers,
          nextStage: result.nextStage,
          clarification: json(result.clarification),
          note: result.note,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'traffic_case_answer',
      description: '记录用户对补问的真实回答（每次 1 至 3 项），每项含 itemId、status（answered 或 unknown）、answer（用户原话）、speaker。review_intake 题只更新复核资料（日期用 YYYY-MM-DD，既往复核用 none/submitted/concluded）；事实题明确回答使证据及下游和复核失效，须影像对照及重新分析。不清楚用 unknown，不得代答。',
      parameters: {
        caseId: { type: 'string', required: true, description: '案件 ID' },
        answers: { type: 'json', required: true, description: '1 至 3 项回答：[{itemId, status: "answered" | "unknown", answer: 用户原话, speaker: 回答者}]' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        return json(recordAnswers(store, args.caseId, args.answers));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'traffic_review_save',
      description: '保存对交警事故认定书的复核资料或分析，独立于六阶段，可直接导入原文启动。section=intake：首次可省略 caseId 新建案件；analysis 必须用既有 caseId。严格字段契约见 traffic_case_read.reviewContract（无 caseId 也可读）。原认定内容不自动采纳为事实；六方面分析须引用原文位置、证据及已读取法条。缺项用 null 并查看 clarification，用户回答由 traffic_case_answer 记录。',
      parameters: {
        caseId: { type: 'string', description: '案件 ID；首次 intake 可省略' },
        section: { type: 'string', enum: ['intake', 'analysis'], required: true },
        payload: { type: 'json', required: true, description: '结构化复核资料或分析对象，未知资料为 null' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) { return json(saveReview(store, lib, args)); },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'traffic_review_export',
      description: '生成《道路交通事故认定复核申请书》可编辑 Word 和相同文字预览。draft 允许缺项占位符，complete 要求资料、主要证据及有依据理由齐备且分析有效。返回版本、路径、缺项和期限提示。生成后调用宿主 present 展示 Word；签名留给本人，不代签或提交。不计算节假日调休截止日期。',
      parameters: {
        caseId: { type: 'string', required: true },
        mode: { type: 'string', enum: ['draft', 'complete'], required: true },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) { return json(await exportReview(store, lib, args.caseId, args.mode)); },
    }),
  );
  ctx.tools.register(
    defineTool({
      name: 'traffic_rule_search',
      description:
        '定位候选法条，返回候选卡（身份、版本、摘录、要件标注、匹配理由），不含全文。精确查询用 lawId + articleNumber（可加 paragraph、item）或在 query 中写法律名称和条款号；关键词查询按主体、行为、通行关系检索。status 为 not_in_library 时该条属于法规缺口。hasMore 为 true 时用 nextOffset 翻页。传 caseId 可按案件的事发日期核对版本。',
      parameters: {
        query: { type: 'string', description: '关键词或“法律名称+条款号”' },
        lawId: { type: 'string', description: 'road_traffic_safety_law、road_traffic_safety_regulations 或 road_traffic_accident_procedures' },
        articleNumber: { type: 'integer', description: '条号' },
        paragraph: { type: 'integer', description: '款号' },
        item: { type: 'integer', description: '项号' },
        tags: { type: 'array', items: { type: 'string' }, description: '补充的检索词组名' },
        caseId: { type: 'string', description: '按该案件的事发日期核对版本' },
        asOf: { type: 'string', description: 'YYYY-MM-DD，显式核对时点优先于事发日期；复核程序条文按申请日期核对' },
        offset: { type: 'integer', description: '分页起点，默认 0' },
        limit: { type: 'integer', description: '每页数量，默认 6，最多 12' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const record = args.caseId ? store.get(args.caseId) : null;
        const lawId = args.lawId ?? lib.byId.get(args.query ?? '')?.lawId ?? detectLaw(args.query ?? '', lib.catalog)?.lawId;
        const procedure = lawId === 'road_traffic_accident_procedures';
        const occurredAt = procedure ? null : (record?.stages.registration.payload as Registration | null)?.occurredAt ?? null;
        return json(
          searchLaw(lib, {
            query: args.query,
            lawId: args.lawId,
            articleNumber: args.articleNumber,
            paragraph: args.paragraph,
            item: args.item,
            tags: args.tags,
            occurredAt,
            asOf: args.asOf ?? (procedure ? record?.review?.intake.applicationDate ?? undefined : undefined),
            offset: args.offset,
            limit: args.limit,
          }),
        );
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'traffic_rule_read',
      description: '按 ruleId 批量读取完整原文、款项结构、版本、来源、原文哈希、要件标注和交叉引用（一次最多 12 条）。只有读取过的条文才能作为法律依据。',
      parameters: {
        ruleIds: { type: 'array', items: { type: 'string' }, required: true, description: '来自 traffic_rule_search 的 ruleId' },
        paragraph: { type: 'integer', description: '定位到某一款' },
        item: { type: 'integer', description: '定位到某一项' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!args.ruleIds.length) throw new Error('ruleIds 不能为空');
        return json(readRules(lib, args.ruleIds, { paragraph: args.paragraph, item: args.item }));
      },
    }),
  );
}
