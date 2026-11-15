# -*- coding: utf-8 -*-
"""
真题 manifest 生成器。
从 public/exams/real/papers/*.json 汇总出 public/exams/real/index.json，
按级别分组、最新套卷在前；hasAudio 依据 resource/真题/audio/<id>.mp3 是否存在。
用法：python build_manifest.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PAPER_DIR = ROOT / "public" / "exams" / "real" / "papers"
AUDIO_DIR = ROOT / "resource" / "真题" / "audio"
OUT = ROOT / "public" / "exams" / "real" / "index.json"

LABEL = {"cet4": "CET-4", "cet6": "CET-6"}


def main() -> None:
    levels: dict[str, list[dict]] = {"cet4": [], "cet6": []}
    for f in sorted(PAPER_DIR.glob("*.json")):
        paper = json.loads(f.read_text(encoding="utf-8"))
        level = paper["level"]
        item = {
            "id": paper["id"],
            "year": paper["year"],
            "month": paper["month"],
            "set": paper["set"],
            "title": paper["title"],
            "hasAudio": (AUDIO_DIR / f"{paper['id']}.mp3").exists(),
        }
        levels.setdefault(level, []).append(item)

    out_levels = []
    for level in ("cet4", "cet6"):
        papers = sorted(
            levels.get(level, []),
            key=lambda p: (p["year"], p["month"], -p["set"]),
            reverse=True,
        )
        # reverse=True 会把 set 也反向；重新按 (year,month) 降序、set 升序稳定排列
        papers = sorted(
            levels.get(level, []),
            key=lambda p: (-p["year"], -p["month"], p["set"]),
        )
        out_levels.append({
            "level": level,
            "label": LABEL[level],
            "count": len(papers),
            "papers": papers,
        })

    OUT.write_text(
        json.dumps({"levels": out_levels}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print("written", OUT)
    for lv in out_levels:
        print(" ", lv["level"], lv["count"], "audio:", sum(p["hasAudio"] for p in lv["papers"]))


if __name__ == "__main__":
    main()
