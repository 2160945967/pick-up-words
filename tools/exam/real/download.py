# -*- coding: utf-8 -*-
"""
download.py — 从 Gitee jasonwarner/cet4-6 批量下载带文本层的真题整卷与音频。

按 level（cet4/cet6）分支读取 Gitee 递归树，把每个考试期的
  真题 PDF / 答案速查 PDF / 听力 MP3
下载到 resource/真题/<level>/<slug>/，slug 形如 2024_06_1。
已存在且大小一致的文件跳过；不做任何 OCR（这些 PDF 带文本层）。

用法：
  python tools/exam/real/download.py cet4
  python tools/exam/real/download.py cet6
  python tools/exam/real/download.py all
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.parse
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DEST_BASE = os.path.join(ROOT, "resource", "真题")

BRANCH = {
    "cet4": ("CET4", "6da9ddcc"),
    "cet6": ("CET6", "8f9cc3ee"),
}
CN_NUM = {"一": 1, "二": 2, "三": 3, "1": 1, "2": 2, "3": 3}


def _api_tree(branch: str, commit: str) -> list[dict]:
    url = (
        f"https://gitee.com/api/v5/repos/jasonwarner/cet4-6/git/trees/"
        f"{commit}?recursive=1"
    )
    with urllib.request.urlopen(url, timeout=40) as r:
        return json.load(r)["tree"]


def _ym_set(text: str) -> tuple[int, int, int]:
    ym = re.search(r"(20\d{2})\s*[年.\-]\s*(\d{1,2})", text)
    if not ym:
        raise ValueError(f"无法解析年月：{text}")
    sm = re.search(r"第?\s*([一二三123])\s*套", text)
    if not sm:
        raise ValueError(f"无法解析套号：{text}")
    return int(ym.group(1)), int(ym.group(2)), CN_NUM[sm.group(1)]


def _slug(year: int, month: int, setn: int) -> str:
    return f"{year}_{month:02d}_{setn}"


def collect_sets(tree: list[dict]) -> dict[str, dict]:
    """把 blob 归并为 {slug: {test, answer, audio(=path)}}。"""
    sets: dict[str, dict] = {}

    def ensure(year, month, setn):
        slug = _slug(year, month, setn)
        return sets.setdefault(
            slug,
            {"year": year, "month": month, "set": setn, "test": None,
             "answer": None, "audio": None},
        )

    for e in tree:
        if e["type"] != "blob":
            continue
        path = e["path"]
        if "听力音频" in path:
            # 音频：文件名含套号
            sm = re.search(r"第?\s*([一二三123])\s*套", os.path.basename(path))
            ym = re.search(r"(20\d{2})\s*[年.\-]\s*(\d{1,2})", path)
            if not (sm and ym):
                continue
            rec = ensure(int(ym.group(1)), int(ym.group(2)), CN_NUM[sm.group(1)])
            rec["audio"] = path
        else:
            # 套卷目录
            try:
                year, month, setn = _ym_set(path)
            except ValueError:
                continue
            rec = ensure(year, month, setn)
            base = os.path.basename(path)
            if "答案" in base:
                rec["answer"] = path
            elif base.lower().endswith(".pdf"):
                rec["test"] = path
    return sets


def _raw_url(branch: str, path: str) -> str:
    enc = urllib.parse.quote(path)
    return f"https://gitee.com/jasonwarner/cet4-6/raw/{branch}/{enc}"


def _download(branch: str, path: str, out: str, expect: int) -> bool:
    if os.path.exists(out) and os.path.getsize(out) == expect:
        return False
    url = _raw_url(branch, path)
    tmp = out + ".part"
    with urllib.request.urlopen(url, timeout=120) as r, open(tmp, "wb") as f:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
    if os.path.getsize(tmp) != expect:
        raise RuntimeError(f"大小不符：{path}")
    os.replace(tmp, out)
    return True


def run_level(level: str) -> None:
    branch, commit = BRANCH[level]
    tree = _api_tree(branch, commit)
    sets = collect_sets(tree)
    size_by_path = {e["path"]: e.get("size", 0) for e in tree if e["type"] == "blob"}

    print(f"[{level}] 识别到 {len(sets)} 个考试期：", sorted(sets))
    for slug in sorted(sets):
        rec = sets[slug]
        dest = os.path.join(DEST_BASE, level, slug)
        os.makedirs(dest, exist_ok=True)
        for kind, fname in (
            ("test", "test.pdf"),
            ("answer", "answer.pdf"),
            ("audio", "listening.mp3"),
        ):
            path = rec[kind]
            if not path:
                print(f"  [缺] {slug} 无 {kind}")
                continue
            out = os.path.join(dest, fname)
            moved = _download(branch, path, out, size_by_path[path])
            tag = "下载" if moved else "跳过"
            print(f"  {tag} {slug}/{fname} ({size_by_path[path]})")


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "all"
    levels = ["cet4", "cet6"] if target == "all" else [target]
    for lv in levels:
        if lv not in BRANCH:
            print("unknown level:", lv)
            sys.exit(1)
        run_level(lv)
