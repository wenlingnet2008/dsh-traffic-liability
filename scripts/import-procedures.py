"""Import the verified official HTML snapshot; fail closed unless all 114 articles are present.

Usage: python3 scripts/import-procedures.py /path/to/official.html
Source: https://szjj.sz.gov.cn/ZWGK/ZCFG/ZCFKS/JTSGYW/content/post_4458457.html
"""
from html.parser import HTMLParser
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import re
import sys

SOURCE = 'https://szjj.sz.gov.cn/ZWGK/ZCFG/ZCFKS/JTSGYW/content/post_4458457.html'
TITLE = '道路交通事故处理程序规定'
LAW_ID = 'road_traffic_accident_procedures'
ROOT = Path(__file__).resolve().parents[1] / 'data' / 'laws'

class Paragraphs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.active = False
        self.buffer = ''
        self.lines = []
    def handle_starttag(self, tag, attrs):
        if tag == 'p':
            self.active = True
            self.buffer = ''
    def handle_data(self, data):
        if self.active:
            self.buffer += data
    def handle_endtag(self, tag):
        if tag == 'p':
            self.lines.append(self.buffer.strip())
            self.active = False

def numeral(text):
    digits = dict(zip('一二三四五六七八九', range(1, 10)))
    result = 0
    pending = 0
    for char in text:
        if char in digits:
            pending = digits[char]
        elif char in '十百':
            result += (pending or 1) * (10 if char == '十' else 100)
            pending = 0
    return result + pending

def main():
    parser = Paragraphs()
    parser.feed(Path(sys.argv[1]).read_text(encoding='utf-8'))
    articles = []
    for line in parser.lines:
        match = re.match(r'^(第([零〇一二三四五六七八九十百]+)条)\s', line)
        if match:
            articles.append((numeral(match[2]), match[1], [line]))
        elif articles and line and not re.match(r'^第[一二三四五六七八九十百]+[章节]', line):
            articles[-1][2].append(line)
    assert [a[0] for a in articles] == list(range(1, 115)), '官方快照未包含连续的114条，停止导入'
    assert '本规定自2018年5月1日起施行' in '\n'.join(articles[-1][2])
    now = datetime.now(timezone.utc).isoformat()
    rules = json.loads((ROOT / 'rules.json').read_text())
    rules = [r for r in rules if r['title'] != TITLE]
    imported = []
    for number, article, lines in articles:
        imported.append(dict(id=f'accident_procedure_article_{number}', title=TITLE, article=article,
            text='\n'.join(lines), sourceUrl=SOURCE, retrievedAt=now, effectiveFrom='2018-05-01',
            effectiveTo=None, jurisdiction='全国', applicability='公安部令第146号，2018年5月1日起施行。程序条文按申请或办理时点核对；通行及责任实体规则另按事故时点核对。官方公开汇编快照，未自动跟踪后续修订。'))
    rules.extend(imported)
    catalog = json.loads((ROOT / 'catalog.json').read_text())
    catalog['version'] = now[:10]
    catalog['laws'] = [l for l in catalog['laws'] if l['lawId'] != LAW_ID]
    catalog['laws'].append(dict(lawId=LAW_ID, title=TITLE, shortNames=[TITLE, '事故处理程序规定'], versions=[dict(versionId='2018-146', label='公安部令第146号公开文本', effectiveFrom='2018-05-01', effectiveTo=None, sourceUrl=SOURCE, checkedOn=now[:10])]))
    catalog['coverage'][LAW_ID] = '第一条至第一百一十四条全文；复核标注覆盖第七十一至七十九条及第一百一十二条。'
    annotations = json.loads((ROOT / 'annotations.json').read_text())
    annotations['version'] = now[:10]
    annotations['annotations'] = [a for a in annotations['annotations'] if not a['ruleId'].startswith('accident_procedure_')]
    checklists = {
        71: ['送达日期', '三个工作日内书面申请', '复核请求、理由和主要证据', '同一事故复核一次'],
        72: ['经原机关提出或直接向上一级提出', '上一级公安机关交通管理部门审查'],
        73: ['逾期不予受理', '收到申请之日为受理之日'],
        74: ['事实、证据、法律及责任划分', '调查及认定程序', '原则上书面审查', '受理后三十日内复核'],
        75: ['申请撤销后的终止', '诉讼受理或批准逮捕后告知相关司法机关'],
        76: ['维持原认定条件', '不影响认定的程序瑕疵可补正或解释', '责令重新调查认定的五种情形'],
        77: ['事故证明成因确实无法查清或仍需调查'],
        78: ['复核结论作出后三个工作日内送达'],
        79: ['原办案单位重新调查认定并撤销原文书', '需要检验鉴定时另核对时限'],
        112: ['一日、二日、三日、五日、十日指工作日，不包括节假日'],
    }
    for number, elements in checklists.items():
        rule = imported[number - 1]
        annotations['annotations'].append(dict(id=f'ann_procedure_{number}', ruleId=rule['id'], legalRef=dict(lawId=LAW_ID, article=rule['article'], articleNumber=number), normRoles=['procedure_rule'], subjects=['当事人', '公安机关交通管理部门'], behaviors=['review'], relations=[], triggerElements=elements, requiredActions=[], prohibitedActions=[], exceptions=[], crossReferences=['accident_procedure_article_112'] if number != 112 else [], anchorQuote=rule['text'].split('\n')[0], sourceTextHash=hashlib.sha256(rule['text'].encode()).hexdigest(), notes=['要件为核对清单，不表示案件已满足；不得自动推算调休截止日期。'], annotationVersion=now[:10]))
    for filename, value in [('rules.json', rules), ('catalog.json', catalog), ('annotations.json', annotations)]:
        (ROOT / filename).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'Imported {len(imported)} official articles; {len(rules)} total rules')

if __name__ == '__main__':
    main()
