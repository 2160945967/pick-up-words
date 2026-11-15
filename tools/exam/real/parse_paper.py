# -*- coding: utf-8 -*-
"""
parse_paper.py — 解析带文本层的 CET 整卷 PDF（真题卷 + 答案速查）。

输入：
  test_pdf   真题卷（Part I Writing / Part II Listening / Part III Reading / Part IV Translation）
  answer_pdf 答案速查（可选；含范文、答案表、参考译文）
输出：
  与 public/exams/real/papers/<id>.json 对应的 dict（见 RealPaper schema）。

只依赖 pymupdf 与标准库。解析失败时抛出 PaperParseError，不静默吞错。
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass

import pymupdf


class PaperParseError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# 文本工具
# ---------------------------------------------------------------------------

_WATERMARK_RE = re.compile(
    r"[ \t]*懒笔记\s*·\s*https?://[^\s]+\s*·\s*在线使用效果更好[ \t]*"
)
_BLANK_RUN_RE = re.compile(r"(?:[ \t]*\n){3,}")


def _norm(text: str) -> str:
    """归一化：全角括号转半角，去懒笔记水印，折叠多余空行（保留换行用于分段）。"""
    text = text.replace("）", ")").replace("（", "(")
    text = _WATERMARK_RE.sub("", text)
    text = _BLANK_RUN_RE.sub("\n\n", text)
    return text


def _pdf_text(path: str) -> str:
    doc = pymupdf.open(path)
    try:
        if any(p.get_text("text").strip() for p in doc) is False:
            raise PaperParseError(f"{path} 无文本层（可能是扫描件，需 OCR）")
        return _norm("\n".join(p.get_text("text", sort=True) for p in doc))
    finally:
        doc.close()


def _clean_inline(text: str) -> str:
    return re.sub(r"[ \t]+", " ", text).strip()


_ASCII_MAP = {"I": "Ⅰ", "II": "Ⅱ", "III": "Ⅲ", "IV": "Ⅳ"}


def _roman_key(run: str) -> str:
    run = run.strip()
    if run in _ASCII_MAP:  # ASCII 大写 I/II/III/IV
        return _ASCII_MAP[run]
    if run == "Ⅰ":
        return "Ⅰ"
    if run == "Ⅱ":
        return "Ⅱ"
    if run == "Ⅳ":
        return "Ⅳ"
    # Ⅲ 在文本层可能是单个 U+2162，也可能是三个 U+2160
    if run == "Ⅲ" or run == "ⅠⅠⅠ":
        return "Ⅲ"
    raise PaperParseError(f"未知罗马数字 Part：{run!r}")


def _split_parts(text: str) -> dict[str, tuple[int, int]]:
    """定位四个 Part 的字符区间（兼容 ASCII I/III 与 Unicode 罗马数字）。"""
    found = {}
    for m in re.finditer(r"Part\s*([ⅠⅡⅢⅣ]+|[IVX]+)", text):
        key = _roman_key(m.group(1))
        if key not in found:
            found[key] = m.start()
    if len(found) < 4:
        raise PaperParseError(f"未能定位全部四个 Part，实际找到：{sorted(found)}")
    ordered = sorted(found.items(), key=lambda kv: kv[1])
    spans = {}
    for i, (roman, start) in enumerate(ordered):
        end = ordered[i + 1][1] if i + 1 < len(ordered) else len(text)
        spans[roman] = (start, end)
    return spans


# ---------------------------------------------------------------------------
# 选择题解析（听力 / 仔细阅读共用）
# ---------------------------------------------------------------------------

_MARK = re.compile(r"(?m)^\s*(?P<q>\d+)\.\s*|(?P<o>[A-D])\)\s*")


def parse_mcq(text: str) -> list[dict]:
    """解析编号 + A-D 选项的题块，返回 [{n, s, o:[{l,t}]}]，选项按字母排序。"""
    raw = []
    for m in _MARK.finditer(text):
        raw.append((m.lastgroup, m.group(m.lastgroup), m.start(), m.end()))
    questions: list[dict] = []
    cur = None
    for i, (kind, val, start, end) in enumerate(raw):
        next_start = raw[i + 1][2] if i + 1 < len(raw) else len(text)
        body = _clean_inline(text[end:next_start])
        if kind == "q":
            cur = {"n": int(val), "s": body, "o": []}
            questions.append(cur)
        elif kind == "o" and cur is not None:
            existing = next((x for x in cur["o"] if x["l"] == val), None)
            if existing is not None:
                # PDF 提取偶发重复标记（如 "A) A) ..."）：保留有正文的一个
                if not existing["t"] and body:
                    existing["t"] = body
                elif body and body != existing["t"]:
                    existing["t"] = (existing["t"] + " " + body).strip()
            else:
                cur["o"].append({"l": val, "t": body})
    for q in questions:
        if len(q["o"]) != 4:
            raise PaperParseError(f"第 {q['n']} 题选项数={len(q['o'])}，应为 4")
        letters = [o["l"] for o in q["o"]]
        if sorted(letters) != ["A", "B", "C", "D"]:
            raise PaperParseError(f"第 {q['n']} 题选项字母异常：{letters}")
        q["o"].sort(key=lambda o: o["l"])
    return questions


# ---------------------------------------------------------------------------
# Part I Writing
# ---------------------------------------------------------------------------

def parse_writing(region: str) -> dict:
    lines = [ln.rstrip() for ln in region.splitlines()]
    # 去掉 Part 标题行，保留 Directions 起的正文
    body = []
    started = False
    for ln in lines:
        if not started:
            if ln.strip().startswith("Directions"):
                started = True
                body.append(ln.strip())
            continue
        body.append(ln.strip())
    prompt = _clean_inline(" ".join(x for x in body if x))
    if not prompt:
        raise PaperParseError("Writing prompt 为空")
    return {"prompt": prompt, "sample": ""}


# ---------------------------------------------------------------------------
# Part II Listening
# ---------------------------------------------------------------------------

_SECTION_RE = re.compile(r"^Section\s+([ABC])\b", re.MULTILINE)
_CLIP_HEAD_RE = re.compile(
    r"Questions\s+(\d+)(?:\s+(?:and|to)\s+(\d+))?[^\n]*", re.MULTILINE)
_SHARED_RE = re.compile(r"本部分与\s*(\d{4})\s*年\s*(\d{1,2})\s*月第\s*(\d)\s*套\s*共用")


def _shared_placeholder(block: str) -> dict | None:
    m = _SHARED_RE.search(block)
    if not m:
        return None
    y, mo, setn = m.groups()
    return {"shared": f"{y}-{int(mo)}-{setn}"}


def parse_listening(region: str) -> dict:
    # 共用听力：本套无独立题目，指向同一年月的另一套（音频也共用）
    shared_m = _SHARED_RE.search(region)
    if shared_m:
        y, mo, setn = shared_m.groups()
        target_slug = f"{y}-{int(mo)}-{setn}"
        return {"audio": "", "sections": [], "transcript": [], "shared": target_slug}

    # 定位 section
    sec_marks = [(m.group(1), m.start()) for m in _SECTION_RE.finditer(region)]
    if len(sec_marks) != 3:
        raise PaperParseError(f"听力 Section 数量={len(sec_marks)}，应为 3")
    sections = []
    names = {"A": "短篇新闻", "B": "长对话", "C": "听力篇章"}
    for i, (key, start) in enumerate(sec_marks):
        end = sec_marks[i + 1][1] if i + 1 < len(sec_marks) else len(region)
        block = region[start:end]
        clips = _parse_clips(block)
        sections.append({"key": key, "name": names[key], "clips": clips})
    total = sum(len(c["questions"]) for s in sections for c in s["clips"])
    if total != 25:
        raise PaperParseError(f"听力题数={total}，应为 25")
    return {"audio": "", "sections": sections, "transcript": []}


def _parse_clips(block: str) -> list[dict]:
    # PDF 提取可能把标题与首题交错、重复，或标题题号范围写错（如漏 22）。
    # 先按标题范围分组，再把未覆盖的题目按物理位置回退到所在 clip。
    all_questions = parse_mcq(block)
    qmap = {q["n"]: q for q in all_questions}
    qpos: dict[int, int] = {}
    for m in re.finditer(r"(?m)^\s*(\d+)\.\s", block):
        qpos.setdefault(int(m.group(1)), m.start())

    heads = list(_CLIP_HEAD_RE.finditer(block))
    if not heads:
        raise PaperParseError("听力块缺少 'Questions ... based on' 分组")
    seen_ranges: set[tuple[int, int]] = set()
    uniq: list[tuple[int, int, re.Match]] = []
    for hm in heads:
        n1 = int(hm.group(1))
        n2 = int(hm.group(2) or n1)
        if (n1, n2) in seen_ranges:
            continue
        seen_ranges.add((n1, n2))
        uniq.append((n1, n2, hm))

    clips = []
    covered: set[int] = set()
    for i, (n1, n2, hm) in enumerate(uniq):
        region_end = uniq[i + 1][2].start() if i + 1 < len(uniq) else len(block)
        nums = [n for n in range(n1, n2 + 1) if n in qmap]
        covered.update(nums)
        clips.append({
            "name": hm.group(0).strip(),
            "questions": [qmap[n] for n in nums],
            "_head": hm.start(),
            "_end": region_end,
        })

    # 未被任何标题范围覆盖的题目，按其物理位置归入所在 clip
    for q in all_questions:
        if q["n"] in covered:
            continue
        p = qpos.get(q["n"])
        if p is None:
            continue
        for c in clips:
            if c["_head"] <= p < c["_end"]:
                c["questions"].append(q)
                covered.add(q["n"])
                break

    for c in clips:
        c["questions"].sort(key=lambda x: x["n"])
        c.pop("_head", None)
        c.pop("_end", None)
    return clips


# ---------------------------------------------------------------------------
# Part III Reading
# ---------------------------------------------------------------------------

def parse_reading(region: str) -> dict:
    # 整个阅读共用：三个 Section 均为占位，指向另一套
    shared_targets = _SHARED_RE.findall(region)
    if shared_targets and not re.search(r"(?m)^\s*A\)\s+[A-Za-z]", region):
        targets = {f"{y}-{int(mo)}-{s}" for y, mo, s in shared_targets}
        if len(targets) == 1:
            return {"shared": next(iter(targets))}

    sec_marks = [(m.group(1), m.start()) for m in _SECTION_RE.finditer(region)]
    if len(sec_marks) != 3:
        raise PaperParseError(f"阅读 Section 数量={len(sec_marks)}，应为 3")
    blocks = {}
    for i, (key, start) in enumerate(sec_marks):
        end = sec_marks[i + 1][1] if i + 1 < len(sec_marks) else len(region)
        blocks[key] = region[start:end]
    return {
        "banked": _parse_banked(blocks["A"]),
        "matching": _parse_matching(blocks["B"]),
        "careful": _parse_careful(blocks["C"]),
    }


def _parse_banked(block: str) -> dict:
    ph = _shared_placeholder(block)
    if ph:
        return ph
    # 词库格式 1：行首 "A) word"（带括号，词库在文章前）
    bank: list[dict] = []
    m1 = re.search(r"(?m)^\s*A\)\s+[A-Za-z]", block)
    if m1:
        passage_raw = block[:m1.start()]
        bank_raw = block[m1.start():]
        for m in re.finditer(r"([A-O])\)\s+([A-Za-z][A-Za-z\-]*)", bank_raw):
            bank.append({"l": m.group(1), "w": m.group(2)})
    else:
        # 格式 2：裸字母两栏（"A  word"，无括号，词库在文章后）
        m2 = re.search(r"(?m)(?:^|\s)([A-O])\s{2,}([A-Za-z][A-Za-z\-]*)", block)
        if not m2:
            raise PaperParseError("选词填空未找到词库")
        passage_raw = block[:m2.start()]
        for l, w in re.findall(
                r"(?m)(?:^|\s)([A-O])\s{2,}([A-Za-z][A-Za-z\-]*)", block):
            bank.append({"l": l, "w": w})
    if len(bank) != 15:
        raise PaperParseError(f"选词填空词库数量={len(bank)}，应为 15")
    bank.sort(key=lambda b: b["l"])

    # 文章：剥离 Section/Directions 头部，按 26-35 编号切分
    # 正文可能含普通数字（如 "past 30 years"），贪心按 26→35 顺序选取空号
    ptext = _strip_directions(passage_raw).replace("\n", " ")
    expected = 26
    blank_matches = []
    for m in re.finditer(r"\b(2[6-9]|3[0-5])\b", ptext):
        n = int(m.group(1))
        if n == expected:
            blank_matches.append((n, m))
            expected += 1
    blank_ns = [n for n, _ in blank_matches]
    if blank_ns != list(range(26, 36)):
        raise PaperParseError(f"选词填空空号异常：{blank_ns}")

    segs = []
    pos = 0
    for n, m in blank_matches:
        pre = _clean_inline(ptext[pos:m.start()])
        if pre:
            segs.append({"t": pre})
        segs.append({"n": n})
        pos = m.end()
    tail = _clean_inline(ptext[pos:])
    if tail:
        segs.append({"t": tail})
    return {
        "passage": segs,
        "bank": bank,
        "questions": [{"n": n, "a": ""} for n in range(26, 36)],
    }


def _parse_matching(block: str) -> dict:
    ph = _shared_placeholder(block)
    if ph:
        return ph
    # 语句块从 36. 起；其前为段落
    stmt_m = re.search(r"(?m)^\s*36\.", block)
    if not stmt_m:
        raise PaperParseError("长篇匹配未找到 36 题")
    para_raw = block[:stmt_m.start()]
    stmt_raw = block[stmt_m.start():]

    # 标题紧邻第一个段落标记（A)）的上一非空行；Directions 与标题间可能无空行
    title = ""
    para_lines = list(re.finditer(r"(?m)^\s*[A-Z]\)\s+", para_raw))
    if para_lines:
        head = para_raw[:para_lines[0].start()]
        head_lines = [ln.strip() for ln in head.splitlines() if ln.strip()]
        if head_lines:
            title = _clean_inline(head_lines[-1])

    paragraphs = []
    pmarks = list(re.finditer(r"(?m)^\s*([A-Z])\)\s+", para_raw))
    for i, m in enumerate(pmarks):
        end = pmarks[i + 1].start() if i + 1 < len(pmarks) else len(para_raw)
        text = _clean_inline(para_raw[m.end():end].replace("\n", " "))
        paragraphs.append({"l": m.group(1), "t": text})
    if len(paragraphs) < 5:
        raise PaperParseError(f"长篇匹配段落数={len(paragraphs)}，疑似解析失败")

    # 语句 36-45
    questions = []
    nmarks = list(re.finditer(r"(?m)^\s*(\d{2})\.\s+", stmt_raw))
    for i, m in enumerate(nmarks):
        end = nmarks[i + 1].start() if i + 1 < len(nmarks) else len(stmt_raw)
        s = _clean_inline(stmt_raw[m.end():end].replace("\n", " "))
        questions.append({"n": int(m.group(1)), "s": s, "a": ""})
    got = [q["n"] for q in questions]
    if got != list(range(36, 46)):
        raise PaperParseError(f"长篇匹配题号异常：{got}")
    return {"title": title, "paragraphs": paragraphs, "questions": questions}


def _parse_careful(block: str) -> list[dict] | dict:
    ph = _shared_placeholder(block)
    if ph:
        return ph
    # 两个 Passage
    pmarks = list(re.finditer(r"Passage\s+(One|Two)\b", block, re.IGNORECASE))
    if len(pmarks) != 2:
        raise PaperParseError(f"仔细阅读 Passage 数量={len(pmarks)}，应为 2")
    out = []
    for i, m in enumerate(pmarks):
        end = pmarks[i + 1].start() if i + 1 < len(pmarks) else len(block)
        sub = block[m.start():end]
        # 题目从第一个编号选择题起
        qm = re.search(r"(?m)^\s*(\d{2})\.\s+A\)|^\s*(\d{2})\.\s", sub)
        qstart = None
        first_q = re.search(r"\b\d{2}\.\s*(?:A\))?", sub)
        # 找到第一个题号位置（Questions 46 to 50 之后）
        qnum = re.search(r"(?m)^\s*(\d{2})\.\s", sub)
        if not qnum:
            raise PaperParseError("仔细阅读未找到题目")
        qstart = qnum.start()
        passage_text = _clean_inline(sub[:qstart].replace("\n", " "))
        # 去掉 "Passage One / Questions ... based on" 头部
        passage_text = re.sub(r"^Passage\s+\w+[\s\S]*?following passage\.\s*", "", passage_text)
        questions = parse_mcq(sub[qstart:])
        out.append({"t": m.group(1).capitalize(), "passage": passage_text,
                    "questions": questions})
    nums = [q["n"] for p in out for q in p["questions"]]
    if nums != list(range(46, 56)):
        raise PaperParseError(f"仔细阅读题号异常：{nums}")
    return out


# ---------------------------------------------------------------------------
# Part IV Translation
# ---------------------------------------------------------------------------

def _strip_directions(region: str) -> str:
    """返回 Directions 块（含其跨行正文）结束位置之后的原始子串。

    水印可能把 Directions 从中间拆开并留下空行：若空行前一行没有句末标点，
    说明 Directions 句子尚未结束，继续消费；遇到句末标点后的空行才停止。
    """
    lines = region.splitlines()
    di = next((i for i, ln in enumerate(lines) if "Directions" in ln), None)
    if di is None:
        raise PaperParseError("未找到 Directions 行")
    j = di + 1
    while j < len(lines):
        if lines[j].strip():
            j += 1
            continue
        k = j - 1
        while k >= 0 and not lines[k].strip():
            k -= 1
        prev = lines[k].strip() if k >= 0 else ""
        if prev and prev[-1] in ".!?":
            break
        j += 1
    return "\n".join(lines[j:])


def _after_directions(region: str) -> str:
    """返回 Part 标题与 Directions 块之后的正文（Directions 可能跨多行）。"""
    rest = _strip_directions(region)
    return _clean_inline(rest.replace("\n", " "))


def parse_translation(region: str) -> dict:
    source = _after_directions(region)
    if not source:
        raise PaperParseError("Translation 原文为空")
    return {"source": source, "reference": ""}


# ---------------------------------------------------------------------------
# 答案速查
# ---------------------------------------------------------------------------

def _part_headers(text: str) -> list[tuple[str, int]]:
    headers = []
    for m in re.finditer(r"Part\s*([ⅠⅡⅢⅣ]+|[IVX]+)", text):
        headers.append((_roman_key(m.group(1)), m.start()))
    # 去重并按位置排序
    seen = set()
    uniq = []
    for key, start in headers:
        if key not in seen:
            seen.add(key)
            uniq.append((key, start))
    return sorted(uniq, key=lambda kv: kv[1])


def _answer_region(text: str, start_key: str, end_key: str | None) -> str:
    headers = _part_headers(text)
    pos = dict(headers)
    if start_key not in pos:
        raise PaperParseError(f"答案 PDF 缺少 Part {start_key}")
    s = pos[start_key]
    e = pos[end_key] if end_key and end_key in pos else len(text)
    return text[s:e]


def parse_answers(path: str) -> dict:
    text = _norm(_pdf_text(path))
    result = {"keys": {}, "writing_sample": "", "translation_reference": ""}

    lis = _answer_region(text, "Ⅱ", "Ⅲ")
    result["keys"].update(_table(lis))
    rd = _answer_region(text, "Ⅲ", "Ⅳ")
    result["keys"].update(_table(rd))

    wm = re.search(r"参考\s*范文[：:]\s*", text)
    if wm:
        tail = text[wm.end():text.find("Part", wm.end())]
        result["writing_sample"] = _clean_inline(tail.replace("\n", " "))
    trm = re.search(r"参考译文[：:]\s*", text)
    if trm:
        result["translation_reference"] = _clean_inline(
            text[trm.end():].replace("\n", " ")
        )
    return result


def _table(region: str) -> dict:
    nums = [int(x) for x in re.findall(r"\d+", region)]
    letters = re.findall(r"\b[A-Z]\b", region)
    if len(nums) != len(letters):
        raise PaperParseError(
            f"答案表数量不匹配：numbers={len(nums)} letters={len(letters)}"
        )
    return dict(zip(nums, letters))


# ---------------------------------------------------------------------------
# 组装
# ---------------------------------------------------------------------------

def build_paper(test_pdf: str, answer_pdf: str | None, meta: dict) -> dict:
    text = _pdf_text(test_pdf)
    spans = _split_parts(text)
    paper = {
        "id": meta["id"],
        "level": meta["level"],
        "year": meta["year"],
        "month": meta["month"],
        "set": meta["set"],
        "title": meta["title"],
        "timing": meta["timing"],
        "writing": parse_writing(text[slice(*spans["Ⅰ"])]),
        "listening": parse_listening(text[slice(*spans["Ⅱ"])]),
        "reading": parse_reading(text[slice(*spans["Ⅲ"])]),
        "translation": parse_translation(text[slice(*spans["Ⅳ"])]),
    }
    if answer_pdf:
        ans = parse_answers(answer_pdf)
        _apply_answers(paper, ans)
    return paper


def _apply_answers(paper: dict, ans: dict) -> None:
    keys = ans["keys"]
    paper["writing"]["sample"] = ans["writing_sample"]
    paper["translation"]["reference"] = ans["translation_reference"]

    for sec in paper["listening"]["sections"]:
        for clip in sec["clips"]:
            for q in clip["questions"]:
                q["a"] = keys.get(q["n"], "")
    for q in paper["reading"]["banked"]["questions"]:
        q["a"] = keys.get(q["n"], "")
    for q in paper["reading"]["matching"]["questions"]:
        q["a"] = keys.get(q["n"], "")
    for passage in paper["reading"]["careful"]:
        for q in passage["questions"]:
            q["a"] = keys.get(q["n"], "")

    missing = [n for n in range(1, 56) if n not in keys]
    if missing:
        raise PaperParseError(f"答案速查缺少题号：{missing}")


if __name__ == "__main__":
    # 手动调试入口
    import json

    if len(sys.argv) < 3:
        print("usage: python parse_paper.py <test.pdf> <answer.pdf> [out.json]")
        sys.exit(1)
    meta0 = {
        "id": "cet4-2024-06-1",
        "level": "cet4",
        "year": 2024,
        "month": 6,
        "set": 1,
        "title": "2024年6月 四级 第1套",
        "timing": {
            "writing": 1800,
            "listening": 1500,
            "reading": 2400,
            "translation": 1800,
            "total": 7500,
        },
    }
    out = build_paper(sys.argv[1], sys.argv[2], meta0)
    target = sys.argv[3] if len(sys.argv) > 3 else None
    payload = json.dumps(out, ensure_ascii=False, indent=2)
    if target:
        open(target, "w", encoding="utf-8").write(payload)
        print("written", target)
    else:
        print(payload)
