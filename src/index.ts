/**
 * Traffic accident liability plugin for DeepSeek Harness. Registers the methodology prompt section
 * and four tools: case read/save with program validation, and law search/read over a verified
 * library. Case files and the law directory are configured per deployment.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-system-prompt';
import Schema from '@deepseek-ai/schemastery';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CaseStore, readCase, submitStage } from './engine.ts';
import { loadLawLibrary, readRules, searchLaw } from './laws.ts';
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

const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const stageList = stages.join('、');

/**
 * Mount the plugin: load the law library (fails loud when missing), open the case store,
 * contribute the methodology section, and register the four tools.
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
        '读取交通事故案件：登记信息、已采纳事实（adoptedFacts）、有效的上游阶段结果、各阶段必填字段（stageContract）和法规库摘要。省略 caseId 时返回案件列表。',
      parameters: {
        caseId: { type: 'string', description: '案件 ID；省略时列出全部案件' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        if (!args.caseId) return json({ cases: store.list(), note: '用 traffic_case_save 保存 registration 且不传 caseId 可新建案件' });
        return json(readCase(store, lib, args.caseId));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'traffic_case_save',
      description: `校验并保存一个阶段的结构化结果。阶段顺序：${stageList}，必须按顺序完成。首次保存 registration 时省略 caseId 会新建案件并返回 caseId。payload 是该阶段的对象本身；必填字段见 traffic_case_read 的 stageContract。结构或引用不合法时返回具体错误，修正后重新保存。`,
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
          note: result.note,
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'traffic_rule_search',
      description:
        '定位候选法条，返回候选卡（身份、版本、摘录、要件标注、匹配理由），不含全文。精确查询用 lawId + articleNumber（可加 paragraph、item）或在 query 中写法律名称和条款号；关键词查询按主体、行为、通行关系检索。status 为 not_in_library 时该条属于法规缺口。hasMore 为 true 时用 nextOffset 翻页。传 caseId 可按案件的事发日期核对版本。',
      parameters: {
        query: { type: 'string', description: '关键词或“法律名称+条款号”' },
        lawId: { type: 'string', description: 'road_traffic_safety_law 或 road_traffic_safety_regulations' },
        articleNumber: { type: 'integer', description: '条号' },
        paragraph: { type: 'integer', description: '款号' },
        item: { type: 'integer', description: '项号' },
        tags: { type: 'array', items: { type: 'string' }, description: '补充的检索词组名' },
        caseId: { type: 'string', description: '按该案件的事发日期核对版本' },
        offset: { type: 'integer', description: '分页起点，默认 0' },
        limit: { type: 'integer', description: '每页数量，默认 6，最多 12' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const occurredAt = args.caseId ? (store.get(args.caseId).stages.registration.payload as Registration | null)?.occurredAt ?? null : null;
        return json(
          searchLaw(lib, {
            query: args.query,
            lawId: args.lawId,
            articleNumber: args.articleNumber,
            paragraph: args.paragraph,
            item: args.item,
            tags: args.tags,
            occurredAt,
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
