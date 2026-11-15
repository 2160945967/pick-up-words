# -*- coding: utf-8 -*-
"""
parse_lazynote.py — 解析懒笔记（lazynote.cn）服务器渲染的「题目解析」HTML。

只依赖标准库 html.parser。覆盖听力页（sections/listening/<slug>/），
提取：Section → 8 个 clip（lt-piece），每 clip 含
  听力原文（lt-en/lt-zh 对照）、卷面题目（qp-N + data-pdh-letter 选项）、
  答案（rp-ans）、题干（rp-stem-en）。
输出与 parse_paper.py 一致的 RealPaper 片段。
"""
from __future__ import annotations

import re
from html.parser import HTMLParser


class LazynoteError(RuntimeError):
    pass


class _ListeningExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.sections: list[dict] = []
        self.questions: list[dict] = []   # 全局卷面题，按出现顺序
        self.answers: list[str] = []
        self.stems: list[str] = []

        # 与 DOM 平行的上下文栈：每项 {"kind","ref"}
        self._dom: list[dict] = []

        # 文本捕获（这些元素互不嵌套）
        self._cap_tag: str | None = None
        self._cap_kind: str | None = None
        self._cap_letter: str | None = None
        self._cap_buf: list[str] = []

    def _top(self, kind: str) -> dict | None:
        for e in reversed(self._dom):
            op = e["opened"]
            if op and op["kind"] == kind:
                return op["ref"]
        return None

    # -- 元素进入 --
    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        d = dict(attrs)
        cls = (d.get("class") or "").split()
        opened = None

        sec_id = d.get("id") or ""
        if sec_id in ("section-a", "section-b", "section-c"):
            key = sec_id.split("-")[1].upper()
            sec = {"key": key, "clips": []}
            self.sections.append(sec)
            opened = {"kind": "section", "ref": sec}

        if "lt-piece" in cls:
            sec = self._top("section")
            if sec is None:
                raise LazynoteError("clip 出现在 section 之外")
            clip = {"name": "", "transcript": [], "questions": []}
            sec["clips"].append(clip)
            opened = {"kind": "clip", "ref": clip}

        qm = re.fullmatch(r"qp-(\d+)", d.get("id") or "")
        if qm:
            q = {"n": int(qm.group(1)), "options": []}
            self.questions.append(q)
            clip = self._top("clip")
            if clip is not None:
                clip["questions"].append(q)
            opened = {"kind": "question", "ref": q}

        self._dom.append({"tag": tag, "opened": opened})

        # 文本捕获起点
        if d.get("data-pdh-letter"):
            self._begin(tag, "option", d["data-pdh-letter"])
        elif "rp-ans" in cls:
            self._begin(tag, "answer")
        elif "rp-stem-en" in cls:
            self._begin(tag, "stem")
        elif "lt-piece-head" in cls:
            self._begin(tag, "head")
        elif "lt-en" in cls:
            self._begin(tag, "en")
        elif "lt-zh" in cls:
            self._begin(tag, "zh")

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def _begin(self, tag: str, kind: str, letter: str | None = None) -> None:
        self._cap_tag = tag
        self._cap_kind = kind
        self._cap_letter = letter
        self._cap_buf = []

    def handle_data(self, data: str) -> None:
        if self._cap_kind is not None:
            self._cap_buf.append(data)

    # -- 元素退出 --
    def handle_endtag(self, tag: str) -> None:
        if self._cap_tag == tag:
            self._finalize()
        if self._dom and self._dom[-1]["tag"] == tag:
            self._dom.pop()

    def _finalize(self) -> None:
        text = "".join(self._cap_buf)
        text = re.sub(r"\s+", " ", text).strip()
        kind = self._cap_kind
        if kind == "option":
            q = self._top("question")
            if q is None:
                raise LazynoteError("选项不属于任何题目")
            q["options"].append({"l": self._cap_letter, "t": text})
        elif kind == "answer":
            self.answers.append(text)
        elif kind == "stem":
            self.stems.append(text)
        elif kind == "head":
            clip = self._top("clip")
            if clip is not None:
                clip["name"] = text
        elif kind in ("en", "zh"):
            clip = self._top("clip")
            if clip is None:
                raise LazynoteError("原文行不属于任何 clip")
            tr = clip["transcript"]
            if kind == "en":
                text = re.sub(r"^\d+\s*", "", text)  # 剥离段号
                tr.append({"en": text, "zh": ""})
            else:
                if not tr:
                    tr.append({"en": "", "zh": text})
                else:
                    tr[-1]["zh"] = text
        self._cap_tag = self._cap_kind = self._cap_letter = None
        self._cap_buf = []


def parse_listening_html(html: str) -> dict:
    ex = _ListeningExtractor()
    ex.feed(html)
    ex.close()

    if len(ex.sections) != 3:
        raise LazynoteError(f"Section 数={len(ex.sections)}，应为 3")
    if len(ex.questions) != 25:
        raise LazynoteError(f"题数={len(ex.questions)}，应为 25")
    if len(ex.answers) != 25:
        raise LazynoteError(f"答案数={len(ex.answers)}，应为 25")
    if len(ex.stems) != 25:
        raise LazynoteError(f"题干数={len(ex.stems)}，应为 25")

    for q in ex.questions:
        letters = sorted(o["l"] for o in q["options"])
        if letters != ["A", "B", "C", "D"]:
            raise LazynoteError(f"第 {q['n']} 题选项异常：{letters}")
        q["options"].sort(key=lambda o: o["l"])

    ordered_ns = sorted(q["n"] for q in ex.questions)
    ans_by_n = dict(zip(ordered_ns, ex.answers))
    stem_by_n = dict(zip(ordered_ns, ex.stems))

    names = {"A": "短篇新闻", "B": "长对话", "C": "听力篇章"}
    out_sections = []
    for sec in ex.sections:
        clips = []
        for clip in sec["clips"]:
            qs = [{
                "n": q["n"],
                "s": stem_by_n.get(q["n"], ""),
                "o": q["options"],
                "a": ans_by_n.get(q["n"], ""),
            } for q in clip["questions"]]
            clips.append({"name": clip["name"] or _clip_label(clip),
                          "transcript": clip["transcript"],
                          "questions": qs})
        out_sections.append({"key": sec["key"], "name": names[sec["key"]],
                             "clips": clips})
    return {"sections": out_sections}


def _clip_label(clip: dict) -> str:
    if clip["questions"]:
        ns = [q["n"] for q in clip["questions"]]
        if len(ns) == 1:
            return f"Question {ns[0]}"
        return f"Questions {ns[0]} to {ns[-1]}"
    return ""


# ---------------------------------------------------------------------------
# 通用补充提取：答案字母 / 写作范文 / 翻译参考译文
# ---------------------------------------------------------------------------

_QID_RE = re.compile(r"^(?:q|qp)-(\d+)$")


_BLOCK_TAGS = {
    "p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6",
    "tr", "td", "th", "section", "article", "header", "footer", "blockquote",
    "pre", "table", "thead", "tbody",
}


class _SupplementExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.keys: dict[int, str] = {}
        self.writing_parts: list[str] = []
        self.translation_parts: list[str] = []

        self._dom: list[dict] = []   # 与 DOM 平行
        self._cap: list[dict] = []   # 捕获栈，支持嵌套

    def _top_q(self) -> int | None:
        for e in reversed(self._dom):
            if e["qnum"] is not None:
                return e["qnum"]
        return None

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        cls = (d.get("class") or "").split()
        elid = d.get("id") or ""

        m = _QID_RE.match(elid)
        qnum = int(m.group(1)) if m else None
        self._dom.append({"tag": tag, "qnum": qnum})

        if "rp-ans" in cls:
            self._cap.append({"kind": "ans", "tag": tag, "buf": []})
        elif "wp-essay__body" in cls:
            self._cap.append({"kind": "essay", "tag": tag, "buf": []})
        elif "tqp-final" in cls:
            self._cap.append({"kind": "final", "tag": tag, "buf": []})
        if self._cap and tag in _BLOCK_TAGS:
            # guarantee whitespace at block boundaries so paragraphs never merge
            self._cap[-1]["buf"].append(" ")

    def handle_data(self, data):
        if self._cap:
            self._cap[-1]["buf"].append(data)

    def handle_endtag(self, tag):
        if self._cap and tag in _BLOCK_TAGS:
            self._cap[-1]["buf"].append(" ")
        if self._cap and self._cap[-1]["tag"] == tag:
            cap = self._cap.pop()
            text = re.sub(r"\s+", " ", "".join(cap["buf"])).strip()
            kind = cap["kind"]
            if kind == "ans":
                lm = re.match(r"([A-Z])", text)
                qnum = self._top_q()
                if lm and qnum is not None:
                    self.keys.setdefault(qnum, lm.group(1))
            elif kind == "essay":
                if text:
                    self.writing_parts.append(text)
            elif kind == "final":
                if text:
                    self.translation_parts.append(text)
        if self._dom and self._dom[-1]["tag"] == tag:
            self._dom.pop()


def extract_supplement(html: str) -> dict:
    ex = _SupplementExtractor()
    ex.feed(html)
    ex.close()
    return {
        "keys": ex.keys,
        "writing_sample": " ".join(ex.writing_parts),
        "translation_reference": " ".join(ex.translation_parts),
    }


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 2:
        print("usage: python parse_lazynote.py <page.html> [out.json]")
        sys.exit(1)
    html = open(sys.argv[1], encoding="utf-8").read()
    result = parse_listening_html(html)
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    if len(sys.argv) > 2:
        open(sys.argv[2], "w", encoding="utf-8").write(payload)
        print("written", sys.argv[2])
    else:
        print(payload)
