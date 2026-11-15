# -*- coding: utf-8 -*-
"""
download_audio.py — 真题听力 MP3 下载器（CET通直链）。

CET通音频直链（约 4MB/套，可直接 <audio> 播放，无需 remux）：
  https://www.cettong.cn/library/<level>/<slug 下划线>/listening.mp3
覆盖 2019–2025；2015–2018、2026 期返回 404，本脚本标记为缺失，不报错。

存储：resource/真题/audio/<paper_id>.mp3（gitignored，不入库）。
paper_id 与 build_real 一致：<level>-<year>-<月去零>-<set>。

CLI:
  python download_audio.py <level>
  python download_audio.py all
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_real import ROOT, list_slugs  # noqa: E402

AUDIO_DIR = ROOT / "resource" / "真题" / "audio"
CETTONG = "https://www.cettong.cn/library"


def _paper_id(level: str, slug: str) -> str:
    year, month, setn = slug.split("-")
    return f"{level}-{year}-{int(month)}-{setn}"


def download_level(level: str) -> dict:
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    available, missing = [], []
    for slug in list_slugs(level):
        pid = _paper_id(level, slug)
        dst = AUDIO_DIR / f"{pid}.mp3"
        if dst.exists() and dst.stat().st_size > 0:
            available.append(pid)
            continue
        url = f"{CETTONG}/{level}/{slug.replace('-', '_')}/listening.mp3"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = resp.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                missing.append(pid)
                continue
            raise
        dst.write_bytes(data)
        available.append(pid)
        print(f"audio {pid} {len(data)} bytes")
    result = {"level": level, "available": available, "missing": missing}
    print(f"[{level}] available={len(available)} missing={len(missing)}")
    if missing:
        print("  missing ids:", ", ".join(missing))
    return result


def main() -> None:
    arg = sys.argv[1] if len(sys.argv) > 1 else "all"
    levels = ["cet4", "cet6"] if arg == "all" else [arg]
    summary = {}
    for level in levels:
        summary[level] = download_level(level)
    (AUDIO_DIR / "_availability.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
