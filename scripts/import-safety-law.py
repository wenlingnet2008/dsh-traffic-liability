#!/usr/bin/env python3
"""Import the complete official Road Traffic Safety Law HTML snapshot.

Usage:
    python3 scripts/import-safety-law.py /path/to/safety-law.html

The importer is deliberately offline: save the official page first, review the
snapshot, then import it. Existing applicability notes for curated articles are
preserved; all other articles receive a neutral version note.
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAW_DIR = ROOT / "data" / "laws"
TITLE = "中华人民共和国道路交通安全法"
LAW_ID = "road_traffic_safety_law"
SOURCE = "https://jtgl.beijing.gov.cn/jgj/jgxx/flfg/fl/205308/index.html"
ARTICLE_RE = re.compile(r"^第([零〇一二三四五六七八九十百]+)条$")
SECTION_RE = re.compile(r"^第[零〇一二三四五六七八九十百]+[章节].*$")


class Paragraphs(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.open = False
        self.buffer: list[str] = []
        self.values: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "p":
            self.open = True
            self.buffer = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "p" and self.open:
            self.values.append("".join(self.buffer))
            self.open = False

    def handle_data(self, data: str) -> None:
        if self.open:
            self.buffer.append(data)


def parse_cn_number(raw: str) -> int:
    text = raw.replace("〇", "零")
    digits = {"零": 0, "一": 1, "二": 2, "三": 3, "四": 4,
              "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
    if text and all(char in digits for char in text):
        return int("".join(str(digits[char]) for char in text))
    if "百" in text:
        high, rest = text.split("百", 1)
        return (digits.get(high, 1) * 100) + (parse_cn_number(rest) if rest else 0)
    if "十" in text:
        high, rest = text.split("十", 1)
        return (digits.get(high, 1) * 10) + (digits.get(rest, 0) if rest else 0)
    if text in digits:
        return digits[text]
    raise ValueError(f"无法解析条号：{raw}")


def normalise(value: str) -> str:
    return "".join(value.split())


def extract(source: Path) -> list[dict[str, object]]:
    parser = Paragraphs()
    parser.feed(source.read_text(encoding="utf-8"))
    articles: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    for raw in parser.values:
        value = normalise(raw)
        match = ARTICLE_RE.fullmatch(value)
        if match:
            number = parse_cn_number(match.group(1))
            current = {"number": number, "article": value, "body": []}
            articles.append(current)
            continue
        if current is None or not value:
            continue
        if SECTION_RE.fullmatch(value):
            continue
        body = current["body"]
        assert isinstance(body, list)
        body.append(value)
        # The official page places navigation/footer paragraphs after article 124.
        if current["number"] == 124:
            break

    numbers = [int(item["number"]) for item in articles]
    expected = list(range(1, 125))
    if numbers != expected:
        raise ValueError(f"官方快照条号不完整或顺序错误：得到 {numbers[:3]}…{numbers[-3:]}，期待 1…124")
    for item in articles:
        if not item["body"]:
            raise ValueError(f"第{item['number']}条没有正文")
    return articles


def main() -> None:
    arg = argparse.ArgumentParser(description=__doc__)
    arg.add_argument("html", type=Path, help="已保存的官方法规网页 HTML")
    arg.add_argument("--retrieved-at", help="ISO 8601 获取时间；默认当前 UTC")
    args = arg.parse_args()
    retrieved = args.retrieved_at or datetime.now(timezone.utc).isoformat(timespec="seconds")
    source = args.html.resolve()
    articles = extract(source)

    rules_path = LAW_DIR / "rules.json"
    rules = json.loads(rules_path.read_text(encoding="utf-8"))
    curated = {
        item["id"]: item["applicability"]
        for item in rules
        if item.get("title") == TITLE and item.get("applicability")
    }
    imported = []
    for item in articles:
        number = int(item["number"])
        rule_id = f"traffic_law_article_{number}"
        article = str(item["article"])
        body = "\n".join(str(value) for value in item["body"])
        imported.append({
            "id": rule_id,
            "title": TITLE,
            "article": article,
            "text": f"{article} {body}",
            "sourceUrl": SOURCE,
            "retrievedAt": retrieved,
            "effectiveFrom": "2021-04-29",
            "effectiveTo": None,
            "jurisdiction": "全国",
            "applicability": curated.get(rule_id, "2021年修正汇编本全文条文。按条文主体、行为、触发条件、例外、事故日期核对；行政处罚条款不等同于事故责任等级或赔偿比例。"),
        })

    old_safety = [index for index, item in enumerate(rules) if item.get("title") == TITLE]
    insert_at = min(old_safety) if old_safety else next(
        (index for index, item in enumerate(rules) if item.get("title") == "道路交通事故处理程序规定"),
        len(rules),
    )
    rules = [item for item in rules if item.get("title") != TITLE]
    insert_at = min(insert_at, len(rules))
    rules[insert_at:insert_at] = imported
    rules_path.write_text(json.dumps(rules, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    catalog_path = LAW_DIR / "catalog.json"
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    catalog["version"] = retrieved[:10]
    for law in catalog["laws"]:
        if law["lawId"] == LAW_ID:
            law["versions"][0]["checkedOn"] = retrieved[:10]
    catalog["coverage"][LAW_ID] = "2021年修正汇编本第一条至第一百二十四条全文；来源为官方公开汇编本。地方性法规尚未收录。"
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"导入完成：{len(imported)} 条，来源：{source}")


if __name__ == "__main__":
    main()
