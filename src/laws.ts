/**
 * Law library for the traffic-liability plugin: verified rule texts, article identity,
 * candidate ranking, and full-text reads with source hashes.
 *
 * Identity is resolved first. A missing article in the named law is a gap and never falls
 * back to another law's same-numbered article.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** One verified article record as stored in `rules.json`. */
export interface Rule {
  id: string;
  title: string;
  article: string;
  text: string;
  sourceUrl: string;
  retrievedAt: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  jurisdiction: string;
  applicability: string;
}
export interface LawVersion {
  versionId: string;
  label: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceUrl: string;
  checkedOn?: string;
}
export interface LawCatalogEntry {
  lawId: string;
  title: string;
  shortNames: string[];
  versions: LawVersion[];
}
export interface LawCatalog {
  version: string;
  laws: LawCatalogEntry[];
  coverage?: Record<string, string>;
}
/** Element checklist bound to the official text it was written against. */
export interface Annotation {
  id: string;
  ruleId: string;
  legalRef: { lawId: string; article: string; articleNumber: number; paragraph?: number; item?: number };
  normRoles: string[];
  subjects: string[];
  behaviors: string[];
  relations: string[];
  triggerElements: string[];
  requiredActions: string[];
  prohibitedActions: string[];
  exceptions: string[];
  crossReferences: string[];
  anchorQuote: string;
  sourceTextHash?: string;
  notes: string[];
  annotationVersion: string;
}

const fallbackCatalog: LawCatalog = {
  version: 'builtin',
  laws: [
    {
      lawId: 'road_traffic_safety_law',
      title: '中华人民共和国道路交通安全法',
      shortNames: ['道路交通安全法', '道交法', '安全法'],
      versions: [
        {
          versionId: '2021',
          label: '2021年修正汇编本',
          effectiveFrom: '2021-04-29',
          effectiveTo: null,
          sourceUrl: 'https://jtgl.beijing.gov.cn/jgj/jgxx/flfg/fl/205308/index.html',
        },
      ],
    },
    {
      lawId: 'road_traffic_safety_regulations',
      title: '中华人民共和国道路交通安全法实施条例',
      shortNames: ['道路交通安全法实施条例', '实施条例', '条例'],
      versions: [
        {
          versionId: '2017',
          label: '2017年修订汇编本',
          effectiveFrom: '2017-10-07',
          effectiveTo: null,
          sourceUrl: 'https://xzfg.moj.gov.cn/front/law/detail?LawID=75',
        },
        {
          versionId: '2004',
          label: '2004年公布文本',
          effectiveFrom: '2004-05-01',
          effectiveTo: '2017-10-06',
          sourceUrl: 'https://xzfg.moj.gov.cn/front/law/detail?LawID=1614',
        },
      ],
    },
  ],
};

const digits: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const cn = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const numeral = '[零〇一二三四五六七八九十百两0-9０-９]+';

/**
 * Chinese or Arabic numeral (including full-width digits) to number.
 * @param raw numeral text such as `九十一`, `91` or `１０１`
 * @returns the number, or null when the text is not a numeral
 */
export function parseNumber(raw: string): number | null {
  const s = raw.trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  let section = 0;
  let number = 0;
  for (const ch of s) {
    if (ch in digits) number = digits[ch];
    else if (ch === '十') {
      section += (number || 1) * 10;
      number = 0;
    } else if (ch === '百') {
      section += (number || 1) * 100;
      number = 0;
    } else return null;
  }
  return section + number;
}

/**
 * Number to the Chinese numeral used in article displays.
 * @param n non-negative integer
 * @returns Chinese numeral text such as `一百零一`
 */
export function numberToChinese(n: number): string {
  if (n < 0 || !Number.isInteger(n)) return String(n);
  if (n < 10) return cn[n];
  if (n < 20) return '十' + (n % 10 ? cn[n % 10] : '');
  if (n < 100) return cn[Math.floor(n / 10)] + '十' + (n % 10 ? cn[n % 10] : '');
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (!rest) return cn[h] + '百';
  if (rest < 10) return cn[h] + '百零' + cn[rest];
  if (rest < 20) return cn[h] + '百一十' + (rest % 10 ? cn[rest % 10] : '');
  return cn[h] + '百' + numberToChinese(rest);
}

export interface ArticleRef {
  lawId?: string;
  lawTitle?: string;
  article: number;
  paragraph?: number;
  item?: number;
  display: string;
}

/**
 * Longest law title or alias contained in the query.
 * @param query free text
 * @param catalog law catalog
 * @returns the catalog entry, or undefined when no law name appears
 */
export function detectLaw(query: string, catalog: LawCatalog): LawCatalogEntry | undefined {
  const aliases = catalog.laws
    .flatMap((law) => [law.title, ...law.shortNames].map((alias) => ({ alias, law })))
    .sort((a, b) => b.alias.length - a.alias.length);
  return aliases.find(({ alias }) => query.includes(alias))?.law;
}

/**
 * Parse an article reference such as `道路交通安全法实施条例第七十条第二款` or `第91条`.
 * @param query free text
 * @param catalog law catalog used to resolve the law name
 * @returns the parsed reference, or null when no `第…条` appears
 */
export function parseArticleRef(query: string, catalog: LawCatalog): ArticleRef | null {
  const article = new RegExp(`第\\s*(${numeral})\\s*条`).exec(query);
  if (!article) return null;
  const number = parseNumber(article[1]);
  if (number === null || number <= 0) return null;
  const paragraph = new RegExp(`第\\s*(${numeral})\\s*款`).exec(query);
  const item = new RegExp(`第\\s*[（(]?(${numeral})[）)]?\\s*项`).exec(query);
  const law = detectLaw(query, catalog);
  const p = paragraph ? (parseNumber(paragraph[1]) ?? undefined) : undefined;
  const i = item ? (parseNumber(item[1]) ?? undefined) : undefined;
  return {
    lawId: law?.lawId,
    lawTitle: law?.title,
    article: number,
    paragraph: p,
    item: i,
    display: `第${numberToChinese(number)}条${p ? `第${numberToChinese(p)}款` : ''}${i ? `第（${numberToChinese(i)}）项` : ''}`,
  };
}

/**
 * Article number at the start of a display such as `第七十条第二款`.
 * @param display article display text
 * @returns the article number, or null when the text does not start with `第…条`
 */
export function articleNumberOf(display: string): number | null {
  const m = new RegExp(`^第\\s*(${numeral})\\s*条`).exec(display.trim());
  return m ? parseNumber(m[1]) : null;
}

/** Verified synonym groups used only for recall and ranking; a hit is never a legal classification. */
export const vocabulary: { canonical: string; terms: string[] }[] = [
  { canonical: 'right_turn', terms: ['右转弯', '右转', '右拐', '向右转'] },
  { canonical: 'left_turn', terms: ['左转弯', '左转', '左拐', '向左转'] },
  { canonical: 'turn', terms: ['转弯', '转向', '拐弯', '拐'] },
  { canonical: 'straight', terms: ['直行'] },
  { canonical: 'yield', terms: ['让行', '先行', '优先通行', '避让', '让直行'] },
  { canonical: 'borrow_lane', terms: ['借道', '借用', '驶入相邻', '受阻', '被占用'] },
  { canonical: 'lane_change', terms: ['变道', '变更车道', '并线'] },
  { canonical: 'overtake', terms: ['超车', '超越'] },
  { canonical: 'u_turn', terms: ['掉头', '调头'] },
  { canonical: 'reverse', terms: ['倒车'] },
  { canonical: 'meet', terms: ['会车', '相对方向来车'] },
  { canonical: 'park', terms: ['停车', '停放', '临时停车', '停靠', '违停', '泊位'] },
  { canonical: 'signal_light', terms: ['信号灯', '红绿灯', '红灯', '绿灯', '黄灯', '放行信号', '停止信号'] },
  { canonical: 'police', terms: ['交通警察', '交警', '现场指挥'] },
  { canonical: 'sign_marking', terms: ['标志', '标线', '停止线'] },
  { canonical: 'intersection', terms: ['交叉路口', '路口', '十字路口', '丁字路口', '交叉口'] },
  { canonical: 'roundabout', terms: ['环形路口', '环岛'] },
  { canonical: 'crosswalk', terms: ['人行横道', '斑马线'] },
  { canonical: 'pedestrian', terms: ['行人'] },
  { canonical: 'nonmotor', terms: ['非机动车', '电动自行车', '自行车', '三轮车', '电动车', '残疾人机动轮椅车'] },
  { canonical: 'motor', terms: ['机动车', '汽车', '小客车', '货车', '摩托车'] },
  { canonical: 'motor_lane', terms: ['机动车道'] },
  { canonical: 'nonmotor_lane', terms: ['非机动车道'] },
  { canonical: 'sidewalk', terms: ['人行道'] },
  { canonical: 'indicate', terms: ['示意', '转向灯', '伸手示意', '鸣喇叭', '灯光信号'] },
  { canonical: 'slow_down', terms: ['减速', '减速慢行', '降低速度', '慢行'] },
  { canonical: 'speed', terms: ['车速', '超速', '限速', '速度', '安全车速', '最高行驶速度'] },
  { canonical: 'distance', terms: ['安全距离', '车距', '距离'] },
  { canonical: 'observe', terms: ['瞭望', '观察', '察明', '确认安全'] },
  { canonical: 'warning', terms: ['警告标志', '危险报警闪光灯', '双闪', '示廓灯', '警示'] },
  { canonical: 'breakdown', terms: ['故障', '抛锚'] },
  { canonical: 'queue', terms: ['排队', '交替通行', '穿插', '依次', '交替'] },
  { canonical: 'ramp', terms: ['匝道'] },
  { canonical: 'expressway', terms: ['高速公路', '快速路'] },
  { canonical: 'emergency_vehicle', terms: ['警车', '消防车', '救护车', '工程救险车', '紧急任务'] },
  { canonical: 'roadwork', terms: ['养护', '施工', '作业车', '清扫车', '洒水车'] },
  { canonical: 'liability', terms: ['责任', '过错', '作用'] },
  { canonical: 'escape', terms: ['逃逸'] },
  { canonical: 'alcohol', terms: ['饮酒', '醉酒', '酒后'] },
  { canonical: 'accident_handling', terms: ['事故认定', '简易程序', '撤离现场', '调解'] },
  { canonical: 'door', terms: ['车门', '开关车门'] },
  { canonical: 'night', terms: ['夜间', '照明', '路灯', '近光灯', '远光灯'] },
  { canonical: 'sudden_turn', terms: ['突然猛拐', '猛拐'] },
  { canonical: 'crossing_road', terms: ['横过', '横穿', '横过道路', '横过机动车道'] },
  { canonical: 'right_side', terms: ['右侧通行', '右侧'] },
  { canonical: 'dedicated_lane', terms: ['专用车道', '公交车道'] },
  { canonical: 'load', terms: ['载物', '载人', '超载'] },
];
const stopwords = new Set(['的', '了', '在', '与', '和', '是', '时', '等', '对', '及', '或', '并', '被', '其', '于', '而', '为', '有', '当']);

/**
 * Whitespace- and punctuation-insensitive form used for quote and anchor comparison.
 * @param s source text
 * @returns the normalized text
 */
export const normalize = (s: string) =>
  s
    .replace(/[\s　]+/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[“”"]/g, '')
    .replace(/[，,。；;：:、]/g, '');

export interface QueryTerms {
  canonicals: string[];
  bigrams: string[];
}
/**
 * Split a keyword query into synonym groups and residual Han bigrams.
 * @param query free text
 * @returns canonical group names plus bigrams of the text not covered by a group
 */
export function queryTerms(query: string): QueryTerms {
  const normalized = normalize(query);
  let residual = normalized;
  const canonicals: string[] = [];
  const ordered = vocabulary
    .flatMap((v) => v.terms.map((term) => ({ term, canonical: v.canonical })))
    .sort((a, b) => b.term.length - a.term.length);
  for (const { term, canonical } of ordered) {
    if (!normalized.includes(term)) continue;
    if (!canonicals.includes(canonical)) canonicals.push(canonical);
    residual = residual.split(term).join(' ');
  }
  const bigrams = new Set<string>();
  for (const chunk of residual.split(/[\sA-Za-z0-9_-]+/)) {
    const chars = [...chunk].filter((ch) => /\p{Script=Han}/u.test(ch) && !stopwords.has(ch));
    for (let i = 0; i + 1 < chars.length; i++) bigrams.add(chars[i] + chars[i + 1]);
  }
  return { canonicals, bigrams: [...bigrams] };
}

export interface ArticleItem {
  number: number;
  text: string;
}
export interface ArticleParagraph {
  number: number;
  text: string;
  lead: string;
  items: ArticleItem[];
}
export interface IndexedRule {
  rule: Rule;
  lawId: string;
  lawTitle: string;
  articleNumber: number | null;
  paragraphs: ArticleParagraph[];
  normalized: string;
}

const itemPattern = new RegExp(`^[（(](${numeral})[）)]`);
/**
 * Paragraphs (款) are lines; a line starting with `（一）` is an item (项) of the current paragraph.
 * @param text article text
 * @returns the paragraph structure
 */
export function articleStructure(text: string): ArticleParagraph[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const paragraphs: ArticleParagraph[] = [];
  for (const line of lines) {
    const item = itemPattern.exec(line);
    const current = paragraphs.at(-1);
    if (item && current) {
      const number = parseNumber(item[1]) ?? current.items.length + 1;
      current.items.push({ number, text: line });
      current.text += '\n' + line;
    } else {
      const lead = paragraphs.length ? line : line.replace(new RegExp(`^第\\s*${numeral}\\s*条\\s*`), '');
      paragraphs.push({ number: paragraphs.length + 1, text: line, lead, items: [] });
    }
  }
  return paragraphs;
}

/**
 * Catalog entry a rule belongs to, by exact title first and longest contained alias second.
 * @param rule rule record
 * @param catalog law catalog
 * @returns the catalog entry, or undefined for an unknown law
 */
export function lawFor(rule: Rule, catalog: LawCatalog): LawCatalogEntry | undefined {
  return (
    catalog.laws.find((l) => l.title === rule.title) ??
    catalog.laws
      .slice()
      .sort((a, b) => b.title.length - a.title.length)
      .find((l) => rule.title.includes(l.title) || l.shortNames.some((s) => rule.title.includes(s)))
  );
}
function versionFor(rule: Rule, catalog: LawCatalog): LawVersion | undefined {
  return lawFor(rule, catalog)?.versions.find(
    (v) =>
      v.sourceUrl === rule.sourceUrl ||
      (v.effectiveFrom === rule.effectiveFrom && v.effectiveTo === rule.effectiveTo),
  );
}

/** Loaded library: rules, catalog, derived index, and element annotations keyed by rule id. */
export interface LawLibrary {
  rules: Rule[];
  catalog: LawCatalog;
  entries: IndexedRule[];
  byId: Map<string, IndexedRule>;
  annotations: Map<string, Annotation[]>;
  annotationVersion: string;
}

function isRule(value: unknown): value is Rule {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  const strings = ['id', 'title', 'article', 'text', 'sourceUrl', 'retrievedAt', 'effectiveFrom', 'jurisdiction', 'applicability'];
  return strings.every((k) => typeof r[k] === 'string') && (r.effectiveTo === null || typeof r.effectiveTo === 'string');
}

/**
 * Load `rules.json` (required), `catalog.json` and `annotations.json` (optional) from one directory.
 * @param dir directory holding the law data files
 * @returns the loaded library
 * @throws when `rules.json` is missing or a record lacks a required field
 */
export function loadLawLibrary(dir: string): LawLibrary {
  const rulesPath = join(dir, 'rules.json');
  if (!existsSync(rulesPath))
    throw new Error(`法规库文件不存在：${rulesPath}。请把插件配置 lawDataDir 指向包含 rules.json 的目录`);
  const raw: unknown = JSON.parse(readFileSync(rulesPath, 'utf8'));
  if (!Array.isArray(raw)) throw new Error(`${rulesPath} 必须是规则数组`);
  raw.forEach((r, i) => {
    if (!isRule(r)) throw new Error(`${rulesPath} 第 ${i + 1} 条记录缺少必填字段`);
  });
  const rules = raw as Rule[];
  const catalogPath = join(dir, 'catalog.json');
  const catalog: LawCatalog = existsSync(catalogPath)
    ? (JSON.parse(readFileSync(catalogPath, 'utf8')) as LawCatalog)
    : fallbackCatalog;
  const annotationsPath = join(dir, 'annotations.json');
  const annotationFile = existsSync(annotationsPath)
    ? (JSON.parse(readFileSync(annotationsPath, 'utf8')) as { version?: string; annotations?: Annotation[] })
    : {};
  const entries = rules.map((rule) => {
    const law = lawFor(rule, catalog);
    return {
      rule,
      lawId: law?.lawId ?? 'unknown_law',
      lawTitle: law?.title ?? rule.title,
      articleNumber: articleNumberOf(rule.article),
      paragraphs: articleStructure(rule.text),
      normalized: normalize(rule.text),
    };
  });
  const annotations = new Map<string, Annotation[]>();
  for (const a of annotationFile.annotations ?? []) annotations.set(a.ruleId, [...(annotations.get(a.ruleId) ?? []), a]);
  return {
    rules,
    catalog,
    entries,
    byId: new Map(entries.map((e) => [e.rule.id, e])),
    annotations,
    annotationVersion: annotationFile.version ?? 'none',
  };
}

/**
 * SHA-256 of the stored article text; legal references may carry it to pin the text they cite.
 * @param rule rule record
 * @returns hex digest
 */
export const ruleHash = (rule: Pick<Rule, 'text'>) => createHash('sha256').update(rule.text).digest('hex');

function verifyAnnotation(a: Annotation, rule: Rule): 'verified' | 'unverified' {
  if (a.sourceTextHash) return a.sourceTextHash === ruleHash(rule) ? 'verified' : 'unverified';
  return normalize(rule.text).includes(normalize(a.anchorQuote)) ? 'verified' : 'unverified';
}

const within = (rule: Rule, day: string) => rule.effectiveFrom <= day && (!rule.effectiveTo || day <= rule.effectiveTo);

/**
 * Why a rule cannot ground a supported conclusion on the given day and place, or null when it can.
 * An unknown accident date skips the version check: the caller records the unverified version in
 * its own limitations instead of blocking the conclusion.
 * @param rule rule record
 * @param occurredAt ISO date-time of the accident, or null when unknown
 * @param jurisdiction registered jurisdiction
 * @returns a Chinese reason, or null when the rule passes every check that can run
 */
export function ruleInForce(rule: Rule, occurredAt: string | null, jurisdiction: string): string | null {
  if (rule.jurisdiction !== jurisdiction && rule.jurisdiction !== '全国') return `法规 ${rule.id} 适用地区不匹配`;
  if (occurredAt === null) return null;
  const day = occurredAt.slice(0, 10);
  if (!within(rule, day)) return `法规 ${rule.id} 在事发日未生效或已失效`;
  return null;
}

export type LookupStatus = 'matched' | 'ambiguous' | 'not_in_library' | 'version_not_covered';
interface Lookup {
  status: LookupStatus;
  identity: string;
  entries: IndexedRule[];
  note: string;
}
function lookupArticle(lib: LawLibrary, ref: ArticleRef, day?: string | null): Lookup {
  const lawTitle = ref.lawTitle ?? (ref.lawId ? lib.catalog.laws.find((l) => l.lawId === ref.lawId)?.title : undefined);
  const identity = `${lawTitle ?? '未指明法律'}${ref.display}`;
  const same = lib.entries.filter((e) => e.articleNumber === ref.article && (!ref.lawId || e.lawId === ref.lawId));
  if (!same.length) {
    const lawKnown = !ref.lawId || lib.entries.some((e) => e.lawId === ref.lawId);
    return {
      status: 'not_in_library',
      identity,
      entries: [],
      note: lawKnown
        ? `当前法规库没有${identity}，属于法规缺口；不得用其他法律的同号条文替代。`
        : `当前法规库没有收录${lawTitle ?? '该法律'}，属于法规缺口。`,
    };
  }
  if (new Set(same.map((e) => e.lawId)).size > 1)
    return {
      status: 'ambiguous',
      identity,
      entries: same,
      note: `多部法律都有${ref.display}，请指明法律名称：${[...new Set(same.map((e) => e.lawTitle))].join('、')}。`,
    };
  if (day) {
    const covering = same.filter((e) => within(e.rule, day));
    if (!covering.length)
      return { status: 'version_not_covered', identity, entries: same, note: `${identity}的已收录版本不覆盖事发日期 ${day}。` };
    return { status: 'matched', identity, entries: covering, note: '' };
  }
  return {
    status: 'matched',
    identity,
    entries: same,
    note: same.length > 1 ? '该条有多个版本；事发日期未知时按日期核对适用版本。' : '',
  };
}

function scoreEntry(entry: IndexedRule, terms: QueryTerms, boosts: Record<string, string[]>) {
  let score = 0;
  const reasons: string[] = [];
  for (const canonical of terms.canonicals) {
    const group = vocabulary.find((v) => v.canonical === canonical);
    const hit = group?.terms.find((t) => entry.normalized.includes(t));
    if (hit) {
      score += 5;
      reasons.push(`原文含“${hit}”`);
    }
    if (boosts[entry.rule.id]?.includes(canonical)) {
      score += 3;
      if (!hit) reasons.push(`要件标注涉及 ${canonical}`);
    }
  }
  let bigramHits = 0;
  for (const bigram of terms.bigrams) if (entry.normalized.includes(bigram)) bigramHits++;
  score += Math.min(bigramHits, 6);
  if (bigramHits && !reasons.length) reasons.push('原文与查询用词部分相同');
  return { entry, score, reasons };
}

/** Candidate card returned by search: identity, version, excerpt and verified checklist facets; never full text. */
export interface CandidateCard {
  ruleId: string;
  lawId: string;
  title: string;
  article: string;
  articleNumber: number | null;
  excerpt: string;
  paragraphCount: number;
  version: { label: string; effectiveFrom: string; effectiveTo: string | null };
  sourceUrl: string;
  annotation: 'verified' | 'unverified' | 'none';
  normRoles: string[];
  subjects: string[];
  behaviors: string[];
  triggerElements: string[];
  exceptions: string[];
  crossReferences: string[];
  matchReason: string[];
}
export type SearchStatus = LookupStatus | 'no_relevant_candidate';
export interface SearchInput {
  query?: string;
  lawId?: string;
  articleNumber?: number;
  paragraph?: number;
  item?: number;
  tags?: string[];
  occurredAt?: string | null;
  /** Explicit review/application date takes precedence over the accident date. */
  asOf?: string;
  offset?: number;
  limit?: number;
}
export interface SearchResult {
  status: SearchStatus;
  identity: string | null;
  cards: CandidateCard[];
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
  notice: string;
}

const excerptOf = (entry: IndexedRule, ref?: ArticleRef | null) => {
  if (ref?.paragraph) {
    const p = entry.paragraphs.find((x) => x.number === ref.paragraph);
    if (p) {
      const item = ref.item ? p.items.find((i) => i.number === ref.item) : undefined;
      return item?.text ?? p.text;
    }
  }
  if (ref?.item) {
    const item = entry.paragraphs.flatMap((p) => p.items).find((i) => i.number === ref.item);
    if (item) return item.text;
  }
  const body = entry.paragraphs[0]?.lead ?? entry.rule.text;
  return body.length > 160 ? body.slice(0, 160) + '…' : body;
};
function card(lib: LawLibrary, entry: IndexedRule, matchReason: string[], ref?: ArticleRef | null): CandidateCard {
  const annotations = lib.annotations.get(entry.rule.id) ?? [];
  const relevant = ref?.paragraph ? annotations.filter((a) => !a.legalRef.paragraph || a.legalRef.paragraph === ref.paragraph) : annotations;
  const verified = relevant.filter((a) => verifyAnnotation(a, entry.rule) === 'verified');
  const version = versionFor(entry.rule, lib.catalog);
  const union = (key: keyof Annotation) => [...new Set(verified.flatMap((a) => a[key] as string[]))];
  return {
    ruleId: entry.rule.id,
    lawId: entry.lawId,
    title: entry.rule.title,
    article: entry.rule.article,
    articleNumber: entry.articleNumber,
    excerpt: excerptOf(entry, ref),
    paragraphCount: entry.paragraphs.length,
    version: { label: version?.label ?? '来源未标注版本', effectiveFrom: entry.rule.effectiveFrom, effectiveTo: entry.rule.effectiveTo },
    sourceUrl: entry.rule.sourceUrl,
    annotation: !annotations.length ? 'none' : verified.length ? 'verified' : 'unverified',
    normRoles: union('normRoles'),
    subjects: union('subjects'),
    behaviors: union('behaviors'),
    triggerElements: union('triggerElements'),
    exceptions: union('exceptions'),
    crossReferences: union('crossReferences'),
    matchReason,
  };
}
const page = <T>(items: T[], offset: number, limit: number) => ({
  items: items.slice(offset, offset + limit),
  total: items.length,
  hasMore: offset + limit < items.length,
  nextOffset: offset + limit < items.length ? offset + limit : null,
});
const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : null);

/**
 * Candidate search: exact identity first, then synonym-aware keyword recall. Returns cards, not full text.
 * @param lib loaded library
 * @param input identity fields or keyword query, with paging
 * @returns ranked candidate cards with paging and a model-facing notice
 */
export function searchLaw(lib: LawLibrary, input: SearchInput): SearchResult {
  if (input.asOf !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf) || !Number.isFinite(Date.parse(input.asOf)) || new Date(input.asOf).toISOString().slice(0, 10) !== input.asOf)) throw new Error('asOf 必须是有效的 YYYY-MM-DD 日期');
  const lookupDay = day(input.asOf ?? input.occurredAt);
  const offset = Math.max(0, input.offset ?? 0);
  const limit = Math.min(Math.max(1, input.limit ?? 6), 12);
  const query = (input.query ?? '').trim();
  const ref: ArticleRef | null =
    input.articleNumber !== undefined
      ? {
          lawId: input.lawId,
          lawTitle: lib.catalog.laws.find((l) => l.lawId === input.lawId)?.title,
          article: input.articleNumber,
          paragraph: input.paragraph,
          item: input.item,
          display: `第${numberToChinese(input.articleNumber)}条${input.paragraph ? `第${numberToChinese(input.paragraph)}款` : ''}${input.item ? `第（${numberToChinese(input.item)}）项` : ''}`,
        }
      : parseArticleRef(query, lib.catalog);
  if (ref) {
    if (input.lawId && !lib.catalog.laws.some((l) => l.lawId === input.lawId))
      return {
        status: 'not_in_library',
        identity: `${input.lawId}${ref.display}`,
        cards: [],
        total: 0,
        hasMore: false,
        nextOffset: null,
        notice: `法规目录没有 lawId 为 ${input.lawId} 的法律，属于法规缺口。`,
      };
    const lookup = lookupArticle(lib, ref, lookupDay);
    const paged = page(
      lookup.entries.map((e) => card(lib, e, [`精确身份：${lookup.identity}`], ref)),
      offset,
      limit,
    );
    return {
      status: lookup.status,
      identity: lookup.identity,
      cards: paged.items,
      total: paged.total,
      hasMore: paged.hasMore,
      nextOffset: paged.nextOffset,
      notice: (lookup.note || '已按法律名称和条款号精确定位。用 traffic_rule_read 读取完整原文、款项定位和要件标注后再判断适用性。').replaceAll('事发日期', input.asOf ? '核对日期' : '事发日期'),
    };
  }
  const idHit = lib.byId.get(query);
  if (idHit)
    return {
      status: lookupDay && !within(idHit.rule, lookupDay) ? 'version_not_covered' : 'matched',
      identity: `${idHit.lawTitle}${idHit.rule.article}`,
      cards: [card(lib, idHit, ['规则 ID 精确匹配'])],
      total: 1,
      hasMore: false,
      nextOffset: null,
      notice: lookupDay && !within(idHit.rule, lookupDay) ? `该版本不覆盖核对日期 ${lookupDay}。` : '规则 ID 精确匹配。用 traffic_rule_read 读取完整原文。',
    };
  const terms = queryTerms(query);
  for (const tag of input.tags ?? []) if (!terms.canonicals.includes(tag)) terms.canonicals.push(tag);
  const boosts: Record<string, string[]> = {};
  for (const [ruleId, list] of lib.annotations) {
    const rule = lib.byId.get(ruleId)?.rule;
    if (rule) boosts[ruleId] = [...new Set(list.filter((a) => verifyAnnotation(a, rule) === 'verified').flatMap((a) => a.behaviors))];
  }
  const when = lookupDay;
  const scored = lib.entries
    .filter((entry) => !input.lawId || entry.lawId === input.lawId)
    .map((entry) => scoreEntry(entry, terms, boosts))
    .filter((s) => s.score > 0 || (!query && !terms.canonicals.length))
    .sort((a, b) => b.score - a.score || a.entry.lawId.localeCompare(b.entry.lawId) || (a.entry.articleNumber ?? 0) - (b.entry.articleNumber ?? 0));
  const cards = scored.map((s) => {
    const reasons = [...s.reasons];
    if (when && !within(s.entry.rule, when)) reasons.push(`注意：该版本不覆盖${input.asOf ? '核对日期' : '事发日期'} ${when}`);
    return card(lib, s.entry, reasons.length ? reasons : ['浏览法规'], null);
  });
  const paged = page(cards, offset, limit);
  return {
    status: paged.total ? 'matched' : 'no_relevant_candidate',
    identity: null,
    cards: paged.items,
    total: paged.total,
    hasMore: paged.hasMore,
    nextOffset: paged.nextOffset,
    notice: paged.total
      ? '相关性只用于排序，不代表条文已适用或已被违反。用 traffic_rule_read 读取完整原文和要件后逐项核对；hasMore 为 true 时继续翻页。'
      : '未检索到相关候选。这只表示检索词没有命中，不等于法律没有规定；可改用法律名称加条款号精确查询，或换用经核对的同义词。',
  };
}

/** Full article read: text, paragraph structure, version, source hash and element annotations. */
export interface ReadRule {
  ruleId: string;
  lawId: string;
  title: string;
  article: string;
  articleNumber: number | null;
  text: string;
  paragraphs: { number: number; text: string; items: { number: number; text: string }[] }[];
  target: { paragraph?: number; item?: number; text: string } | null;
  version: { label: string; effectiveFrom: string; effectiveTo: string | null };
  jurisdiction: string;
  sourceUrl: string;
  retrievedAt: string;
  sourceTextHash: string;
  applicabilityNote: string;
  annotations: {
    id: string;
    paragraph?: number;
    item?: number;
    status: 'verified' | 'unverified';
    normRoles: string[];
    subjects: string[];
    behaviors: string[];
    relations: string[];
    triggerElements: string[];
    requiredActions: string[];
    prohibitedActions: string[];
    exceptions: string[];
    crossReferences: string[];
    notes: string[];
  }[];
}
export interface ReadResult {
  rules: ReadRule[];
  missing: string[];
  notice: string;
}
/**
 * Read full texts for already-located rules, with optional paragraph/item targeting.
 * @param lib loaded library
 * @param ruleIds rule ids, at most twelve are read
 * @param target paragraph and item to highlight
 * @returns the read rules plus the ids that are not in the library
 */
export function readRules(lib: LawLibrary, ruleIds: string[], target: { paragraph?: number; item?: number } = {}): ReadResult {
  const rules: ReadRule[] = [];
  const missing: string[] = [];
  for (const id of [...new Set(ruleIds)].slice(0, 12)) {
    const entry = lib.byId.get(id);
    if (!entry) {
      missing.push(id);
      continue;
    }
    const version = versionFor(entry.rule, lib.catalog);
    let targetText: ReadRule['target'] = null;
    if (target.paragraph) {
      const p = entry.paragraphs.find((x) => x.number === target.paragraph);
      const item = p && target.item ? p.items.find((i) => i.number === target.item) : undefined;
      if (p) targetText = { paragraph: target.paragraph, item: item ? target.item : undefined, text: item?.text ?? p.text };
    } else if (target.item) {
      const item = entry.paragraphs.flatMap((p) => p.items).find((i) => i.number === target.item);
      if (item) targetText = { item: target.item, text: item.text };
    }
    rules.push({
      ruleId: entry.rule.id,
      lawId: entry.lawId,
      title: entry.rule.title,
      article: entry.rule.article,
      articleNumber: entry.articleNumber,
      text: entry.rule.text,
      paragraphs: entry.paragraphs.map((p) => ({ number: p.number, text: p.text, items: p.items })),
      target: targetText,
      version: { label: version?.label ?? '来源未标注版本', effectiveFrom: entry.rule.effectiveFrom, effectiveTo: entry.rule.effectiveTo },
      jurisdiction: entry.rule.jurisdiction,
      sourceUrl: entry.rule.sourceUrl,
      retrievedAt: entry.rule.retrievedAt,
      sourceTextHash: ruleHash(entry.rule),
      applicabilityNote: entry.rule.applicability,
      annotations: (lib.annotations.get(id) ?? []).map((a) => ({
        id: a.id,
        paragraph: a.legalRef.paragraph,
        item: a.legalRef.item,
        status: verifyAnnotation(a, entry.rule),
        normRoles: a.normRoles,
        subjects: a.subjects,
        behaviors: a.behaviors,
        relations: a.relations,
        triggerElements: a.triggerElements,
        requiredActions: a.requiredActions,
        prohibitedActions: a.prohibitedActions,
        exceptions: a.exceptions,
        crossReferences: a.crossReferences,
        notes: a.notes,
      })),
    });
  }
  return {
    rules,
    missing,
    notice:
      '引用时使用 ruleId、lawId、article（可到款、项）、原文片段 quote、sourceUrl 和 sourceTextHash。要件标注只是核对清单；未核验（unverified）的标注不能直接作为适用判断依据。',
  };
}

/**
 * Library coverage summary shown to the model at case read time.
 * @param lib loaded library
 * @returns per-law counts, article ranges and the retrieval protocol
 */
export function catalogSummary(lib: LawLibrary) {
  const counts = new Map<string, { count: number; min: number | null; max: number | null }>();
  for (const e of lib.entries) {
    const c = counts.get(e.lawId) ?? { count: 0, min: null, max: null };
    c.count++;
    if (e.articleNumber !== null) {
      c.min = c.min === null ? e.articleNumber : Math.min(c.min, e.articleNumber);
      c.max = c.max === null ? e.articleNumber : Math.max(c.max, e.articleNumber);
    }
    counts.set(e.lawId, c);
  }
  return {
    version: lib.catalog.version,
    annotationVersion: lib.annotationVersion,
    laws: lib.catalog.laws.map((law) => ({
      lawId: law.lawId,
      title: law.title,
      shortNames: law.shortNames,
      versions: law.versions.map((v) => ({ label: v.label, effectiveFrom: v.effectiveFrom, effectiveTo: v.effectiveTo })),
      articlesInLibrary: counts.get(law.lawId)?.count ?? 0,
      articleRange: counts.get(law.lawId) ? `${counts.get(law.lawId)!.min ?? '?'}–${counts.get(law.lawId)!.max ?? '?'}` : '未收录',
      coverage: lib.catalog.coverage?.[law.lawId] ?? '',
    })),
    howTo:
      'traffic_rule_search 支持精确查询（lawId + articleNumber，或“道路交通安全法实施条例第七十条第二款”）和行为关键词查询；traffic_rule_read 按 ruleId 读取完整原文。指定法律缺条时返回 not_in_library，不得改用其他法律的同号条文。',
  };
}
