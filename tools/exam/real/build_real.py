# -*- coding: utf-8 -*-
"""
build_real.py — 真题数据构建编排（懒笔记 HTML + 真题整卷 PDF）。

对每套（slug=YYYY-MM-N）：
  1. 下载「真题（整卷）.pdf」，用 parse_paper 出整卷结构（无答案）；
  2. 下载 7 个题型 HTML，用 extract_supplement 取答案/范文/参考译文；
  3. 用 parse_listening_html 取听力原文，按 clip 顺序并入；
  4. 回填全部答案并校验 1–55 覆盖，输出 RealPaper JSON。

只依赖标准库 + pymupdf（经 parse_paper）。
CLI:
  python build_real.py list <level>
  python build_real.py one <level> <slug>
  python build_real.py all <level>
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse_lazynote import extract_supplement, parse_listening_html  # noqa: E402
from parse_paper import PaperParseError, build_paper  # noqa: E402

EXAM_BASE = "https://english-exam.lazynote.cn"
DL_BASE = "https://downloads.lazynote.cn"

ROOT = Path(__file__).resolve().parents[3]  # 项目根
CACHE = ROOT / "resource" / "真题" / "lazynote"
OUT_DIR = ROOT / "public" / "exams" / "real" / "papers"

TIMING = {
    "cet4": {"writing": 1800, "listening": 1500, "reading": 2400,
             "translation": 1800, "total": 7500},
    "cet6": {"writing": 1800, "listening": 1800, "reading": 2400,
             "translation": 1800, "total": 7800},
}
LEVEL_CN = {"cet4": "英语四级", "cet6": "英语六级"}


def _get(url: str, retries: int = 5) -> bytes:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=90) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last_err = e
            if attempt < retries - 1:
                import time
                time.sleep(3 * (attempt + 1))
    raise last_err  # type: ignore[misc]


def _fetch_cached(url: str, cache_path: Path) -> str:
    if not cache_path.exists():
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(_get(url))
    return cache_path.read_text(encoding="utf-8")


def list_slugs(level: str) -> list[str]:
    html = _get(f"{EXAM_BASE}/{level}/").decode("utf-8")
    return sorted(set(re.findall(rf"/{level}/paper/(\d{{4}}-\d{{2}}-\d)/", html)))


def _section_relpaths(slug: str) -> dict[str, str]:
    return {
        "listening": f"/sections/listening/{slug}/",
        "writing": f"/sections/{slug}/part1/",
        "banked": f"/sections/{slug}/part3-section-a/",
        "matching": f"/sections/{slug}/part3-section-b/",
        "careful1": f"/sections/{slug}/part3-section-c-1/",
        "careful0": f"/sections/{slug}/part3-section-c/",
        "careful2": f"/sections/{slug}/part3-section-c-2/",
        "translation": f"/sections/{slug}/part-iv/",
    }


def _pdf_url(level: str, slug: str) -> str:
    year, month, setn = slug.split("-")
    name = f"{LEVEL_CN[level]}{year}年{int(month)}月第{setn}套真题（整卷）.pdf"
    return f"{DL_BASE}/{level}/{slug}/{urllib.parse.quote(name)}"


def _part_questions(part_name: str, part: dict) -> list[dict]:
    if part_name == "listening":
        return [q for sec in part["sections"] for c in sec["clips"]
                for q in c["questions"]]
    if part_name == "reading":
        qs = list(part["banked"]["questions"])
        qs += list(part["matching"]["questions"])
        for passage in part["careful"]:
            qs += passage["questions"]
        return qs
    return []


def _resolve_shared(part_name: str, paper: dict, target_slug: str,
                    level: str, merged_keys: dict[int, str]) -> None:
    sy, smo, sset = target_slug.split("-")
    target_pid = f"{level}-{sy}-{int(smo)}-{sset}"
    src_path = OUT_DIR / f"{target_pid}.json"
    if not src_path.exists():
        raise PaperParseError(f"共用源套尚未构建：{target_pid}（需先构建源套）")
    src_paper = json.loads(src_path.read_text(encoding="utf-8"))
    copied = json.loads(json.dumps(src_paper[part_name]))
    if part_name == "listening":
        copied["audio"] = target_pid
    copied["shared"] = target_pid
    paper[part_name] = copied
    for q in _part_questions(part_name, copied):
        merged_keys.setdefault(q["n"], q["a"])


def _sub_questions(sub_name: str, node) -> list[dict]:
    if sub_name in ("banked", "matching"):
        return list(node["questions"])
    if sub_name == "careful":
        return [q for passage in node for q in passage["questions"]]
    return []


def _resolve_reading_sub(reading: dict, sub_name: str, target_slug: str,
                         level: str, merged_keys: dict[int, str]) -> None:
    sy, smo, sset = target_slug.split("-")
    target_pid = f"{level}-{sy}-{int(smo)}-{sset}"
    src_path = OUT_DIR / f"{target_pid}.json"
    if not src_path.exists():
        raise PaperParseError(f"共用源套尚未构建：{target_pid}（需先构建源套）")
    src_reading = json.loads(src_path.read_text(encoding="utf-8"))["reading"]
    copied = json.loads(json.dumps(src_reading[sub_name]))
    if isinstance(copied, dict):
        copied["shared"] = target_pid
    reading[sub_name] = copied
    for q in _sub_questions(sub_name, copied):
        merged_keys.setdefault(q["n"], q["a"])


def build_one(level: str, slug: str) -> dict:
    cdir = CACHE / level / slug
    year, month, setn = slug.split("-")
    paper_id = f"{level}-{year}-{int(month)}-{setn}"
    meta = {
        "id": paper_id,
        "level": level,
        "year": int(year),
        "month": int(month),
        "set": int(setn),
        "title": f"{year}年{int(month)}月 {('四级' if level=='cet4' else '六级')} 第{setn}套",
        "timing": TIMING[level],
    }

    # 1) 整卷 PDF（缓存）
    pdf_path = cdir / "paper.pdf"
    if not pdf_path.exists():
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(_get(_pdf_url(level, slug)))
    paper = build_paper(str(pdf_path), None, meta)

    # 共用部分（听力/阅读）：从已构建的源套深拷贝，音频指向源套
    merged_keys: dict[int, str] = {}
    for part_name in ("listening", "reading"):
        target_slug = paper[part_name].get("shared")
        if target_slug:
            _resolve_shared(part_name, paper, target_slug, level, merged_keys)

    # 阅读子部分共用：banked/matching/careful 可单独指向源套
    if not paper["reading"].get("shared"):
        for sub_name in ("banked", "matching", "careful"):
            node = paper["reading"][sub_name]
            if isinstance(node, dict) and node.get("shared"):
                _resolve_reading_sub(paper["reading"], sub_name,
                                     node["shared"], level, merged_keys)

    # 2) 各题型 HTML：答案 + 范文/译文
    for kind, rel in _section_relpaths(slug).items():
        url = EXAM_BASE + f"/{level}" + rel
        html_path = cdir / f"{kind}.html"
        try:
            html = _fetch_cached(url, html_path)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            raise
        sup = extract_supplement(html)
        for n, letter in sup["keys"].items():
            merged_keys.setdefault(n, letter)
        if kind == "writing" and sup["writing_sample"]:
            paper["writing"]["sample"] = sup["writing_sample"]
        if kind == "translation" and sup["translation_reference"]:
            paper["translation"]["reference"] = sup["translation_reference"]
        if kind == "listening":
            _merge_transcript(paper, html)

    # 3) 回填答案
    _apply_keys(paper, merged_keys)
    return paper


def _merge_transcript(paper: dict, listening_html: str) -> None:
    parsed = parse_listening_html(listening_html)
    src_clips = [c for s in parsed["sections"] for c in s["clips"]]
    dst_clips = [c for s in paper["listening"]["sections"] for c in s["clips"]]
    if len(src_clips) != len(dst_clips):
        raise PaperParseError(
            f"听力 clip 数不一致：html={len(src_clips)} pdf={len(dst_clips)}"
        )
    for sc, dc in zip(src_clips, dst_clips):
        sn = sorted(q["n"] for q in sc["questions"])
        dn = sorted(q["n"] for q in dc["questions"])
        if sn != dn:
            raise PaperParseError(f"clip 题号不一致：{sn} vs {dn}")
        dc["transcript"] = sc["transcript"]


def _apply_keys(paper: dict, keys: dict[int, str]) -> None:
    def assign(question: dict) -> None:
        question["a"] = keys.get(question["n"], "")

    for sec in paper["listening"]["sections"]:
        for clip in sec["clips"]:
            for q in clip["questions"]:
                assign(q)
    for q in paper["reading"]["banked"]["questions"]:
        assign(q)
    for q in paper["reading"]["matching"]["questions"]:
        assign(q)
    for passage in paper["reading"]["careful"]:
        for q in passage["questions"]:
            assign(q)

    missing = [n for n in range(1, 56) if n not in keys]
    if missing:
        raise PaperParseError(f"答案缺失题号：{missing}")


def write_paper(paper: dict) -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    target = OUT_DIR / f"{paper['id']}.json"
    target.write_text(
        json.dumps(paper, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return target


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("usage: build_real.py <list|one|all> <level> [slug]")
        sys.exit(1)
    cmd, level = sys.argv[1], sys.argv[2]
    if cmd == "list":
        for s in list_slugs(level):
            print(s)
    elif cmd == "one":
        slug = sys.argv[3]
        p = build_one(level, slug)
        t = write_paper(p)
        print("written", t)
    elif cmd == "all":
        for slug in list_slugs(level):
            p = build_one(level, slug)
            t = write_paper(p)
            print("written", t.name)
    else:
        print("unknown command", cmd)
        sys.exit(1)
