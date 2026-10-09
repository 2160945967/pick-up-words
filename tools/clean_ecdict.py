# -*- coding: utf-8 -*-
"""清洗 stardict.csv 的损坏中文（B 类），干跑只统计抽样。
损坏类型：
  MIX  阿拉伯/西里尔/希腊锚字符与拉丁/ASCII/另一区段混合的乱码 run；同区段纯外文短语合法
       （波斯语人名、俄语原文）。
  LAT  紧邻中文、孤立出现的拉丁扩展/修饰/组合/私用区字符（ò麻=苘麻、ǎ蕨属=金蕨）；
       构成外文词的变音字母（Abélard、après、Böhm）合法。
  NAM  人名中拉丁字母损坏成西里尔（José→JosМ、Jöns→JГns），按高置信映射还原。
处理：末尾损坏义整体删除（保留前面扩充）；词中缺字且原版干净则原版替换；私用区删除。
"""
import csv, sys, re

ORIG = r"D:\学习\英语\程序\拾词 - electron\ECDICT-master\ecdict.csv"
MOD = r"D:\学习\英语\程序\拾词 - electron\resource\stardict.csv"

ARABIC = re.compile(r'[\u0600-\u077F]')
CYRILLIC = re.compile(r'[\u0400-\u04FF]')
GREEK = re.compile(r'[\u0370-\u03FF]')
LATIN_EXT = re.compile(r'[\u00C0-\u024F]')
MODIFIER = re.compile(r'[\u02B0-\u02FF]')
COMBINING = re.compile(r'[\u0300-\u036F]')
PUA = re.compile(r'[\uE000-\uF8FF]')
CJK = re.compile(r'[\u4e00-\u9fff]')

# 人名中西里尔→拉丁的高置信还原
CYR_TO_LAT = {'\u041c':'é', '\u0413':'ö', '\u0451':'ë', '\u0435':'e',
              '\u0437':'e', '\u0438':'i', '\u043e':'o'}

def is_arabic(ch): return bool(ARABIC.match(ch))
def is_cyrillic(ch): return bool(CYRILLIC.match(ch))
def is_greek(ch): return bool(GREEK.match(ch))
def is_anchor(ch): return is_arabic(ch) or is_cyrillic(ch)
# 注：希腊字母 α/β/γ 在科技术语（α细胞、β受体、TGFα）中合法，不纳入自动判损；
# 仅当希腊字符与阿拉伯/西里尔乱码同 run 时才在 mixed 检测中作为 foreign 处理。
def is_latin_ext(ch):
    if ord(ch) in (0x00D7, 0x00F7):
        return False
    return bool(LATIN_EXT.match(ch))
def is_modifier(ch): return bool(MODIFIER.match(ch))
def is_combining(ch): return bool(COMBINING.match(ch))
def is_pua(ch): return bool(PUA.match(ch))
def is_garble(ch):
    return is_anchor(ch) or is_latin_ext(ch) or is_modifier(ch) or is_combining(ch) or is_pua(ch)

def clean_orig_translation(t):
    if not t or not CJK.search(t):
        return False
    return not any(is_garble(c) for c in t)

def run_char(ch):
    if not ch: return False
    if is_garble(ch): return True
    return ch.isascii() and (ch.isalpha() or ch.isdigit())

def restore_cyrillic(s):
    """人名/拉丁语境中的西里尔字符按映射还原为拉丁字母。"""
    out = []
    for k, ch in enumerate(s):
        if is_cyrillic(ch) and ch in CYR_TO_LAT:
            left = s[k-1] if k > 0 else ''
            right = s[k+1] if k+1 < len(s) else ''
            latin_ctx = (left.isascii() and (left.isalpha() or left in "[]'/ ")) or \
                        (right.isascii() and right.isalpha())
            if latin_ctx:
                out.append(CYR_TO_LAT[ch]); continue
        out.append(ch)
    return ''.join(out)

def expand(s, k):
    n = len(s); l = k; r = k + 1
    while l > 0:
        if run_char(s[l-1]): l -= 1
        elif s[l-1] == ' ' and l-2 >= 0 and run_char(s[l-2]): l -= 1
        else: break
    while r < n:
        if run_char(s[r]): r += 1
        elif s[r] == ' ' and r+1 < n and run_char(s[r+1]): r += 1
        else: break
    return l, r

def same_anchor(a, b):
    return (is_arabic(a) and is_arabic(b)) or (is_cyrillic(a) and is_cyrillic(b)) \
        or (is_greek(a) and is_greek(b))

def find_mixed_runs(s):
    runs = []
    for k, ch in enumerate(s):
        if is_anchor(ch) and not any(l <= k < r for l, r in runs):
            l, r = expand(s, k)
            seg = s[l:r]
            def foreign(c):
                if c.isascii() and c.isalpha(): return True
                if is_latin_ext(c) or is_modifier(c) or is_combining(c) or is_pua(c): return True
                if is_greek(c): return True
                if is_anchor(c) and not same_anchor(ch, c): return True
                return False
            if any(is_anchor(c) for c in seg) and any(foreign(c) for c in seg):
                runs.append((l, r))
    return merge_runs(runs, s)

def find_garble_singles(s):
    """紧邻中文、孤立的损坏单字；私用区字符一律损坏。"""
    out = []
    for k, ch in enumerate(s):
        left = s[k-1] if k > 0 else ''
        right = s[k+1] if k+1 < len(s) else ''
        if is_pua(ch):
            out.append((k, k+1)); continue
        if is_modifier(ch):
            if not (run_char(left) or run_char(right)):
                out.append((k, k+1))
            continue
        if not (is_latin_ext(ch) or is_combining(ch) or
                (is_anchor(ch) and ch not in CYR_TO_LAT)):
            continue
        adjacent_cjk = bool(CJK.match(left) or CJK.match(right))
        in_latin_word = (left.isascii() and left.isalpha()) or (right.isascii() and right.isalpha())
        # 拉丁扩展字符紧跟词性标记之后（如 best 末尾 “/adv.õ”）
        after_pos_tag = is_latin_ext(ch) and bool(
            re.search(r'[/\\]?[a-z]{1,4}\.$', s[max(0, k-6):k]))
        if (adjacent_cjk or after_pos_tag) and not in_latin_word:
            out.append((k, k+1))
    return out

def merge_runs(runs, s):
    merged = []
    for l, r in runs:
        if merged:
            pl, pr = merged[-1]
            if re.fullmatch(r'[\s;,\u3001]*', s[pr:l]):
                merged[-1] = (pl, r); continue
        merged.append((l, r))
    return merged

def load_orig():
    orig = {}
    with open(ORIG, encoding='utf-8', newline='') as f:
        r = csv.reader(f); next(r)
        for row in r:
            if len(row) > 3: orig[row[0]] = row[3]
    return orig

def segment_corrupt(tail):
    return bool(find_mixed_runs(tail) or find_garble_singles(tail))

def tail_is_garble(tail):
    if segment_corrupt(tail):
        return True
    # 分号后无中文、且阿拉伯/西里尔等损坏字符占非空字符绝大多数（如 blackboard 末尾 ڰ）
    if tail and not CJK.search(tail):
        nonspace = [c for c in tail if not c.isspace()]
        if nonspace and any(is_anchor(c) for c in nonspace):
            bad = sum(1 for c in nonspace if is_garble(c))
            if bad / len(nonspace) >= 0.8:
                return True
    return False

def strip_tail_garbage(cur):
    while True:
        semi = max(cur.rfind('\uff1b'), cur.rfind(';'))
        if semi < 0:
            return cur
        if tail_is_garble(cur[semi+1:]):
            cur = cur[:semi].rstrip(); continue
        return cur

def delete_spans(s, spans):
    for l, r in reversed(sorted(spans)):
        s = s[:l] + s[r:]
    return s

# A 类（经人工核对）：改版翻译与词头无关/残缺，用原版干净翻译替换
A_FORCE_REPLACE = {'end', 'abb', 'aac'}

def plan_translation(word, trans, orig):
    otrans = orig.get(word, '')
    if word in A_FORCE_REPLACE and clean_orig_translation(otrans):
        return ('replace', otrans)
    s0 = restore_cyrillic(trans)
    cur = strip_tail_garbage(s0)
    runs = find_mixed_runs(cur)
    singles = find_garble_singles(cur)
    spans = merge_runs(sorted(runs + singles), cur)
    if not spans:
        if cur == trans:
            return None
        return ('delete', re.sub(r'[\s;,\u3001]*$', '', cur))
    # 删除损坏片段（末尾乱码/私用区/无映射字符），优先保留改版正确释义
    kept = delete_spans(cur, spans)
    kept = re.sub(r'[\s;,\u3001]*[;,\u3001]\s*$', '', kept.strip())
    if CJK.search(kept):
        return ('delete', kept)
    # 无中文但为有效 ASCII 文本（如 “prep. = re”，非纯编号标记）也保留
    if re.search(r'[a-z]{2,}', kept) and not re.fullmatch(r'[A-Z]\d+[A-Z0-9]*', kept.strip()):
        return ('delete', kept)
    # 删除后已无有效内容（整段损坏）→ 干净原版替换
    if clean_orig_translation(otrans):
        return ('replace', otrans)
    return ('manual', trans)

def char_types(t):
    types = set()
    for c in t:
        if is_pua(c): types.add('PUA')
        elif is_arabic(c): types.add('ARAB')
        elif is_cyrillic(c): types.add('CYR')
        elif is_latin_ext(c): types.add('LAT')
        elif is_modifier(c): types.add('MOD')
        elif is_combining(c): types.add('COMB')
    return types

def main():
    from collections import defaultdict
    orig = load_orig()
    counts = {'delete': 0, 'replace': 0, 'manual': 0}
    typestat = defaultdict(int)
    dispersed = []
    manual_list = []
    with open(MOD, encoding='utf-8', newline='') as f:
        r = csv.reader(f); next(r)
        for row in r:
            if len(row) < 4: continue
            plan = plan_translation(row[0], row[3], orig)
            if not plan: continue
            kind, val = plan
            counts[kind] += 1
            if kind == 'delete':
                for t in char_types(row[3]): typestat[t] += 1
                if counts['delete'] % 40 == 1 and len(dispersed) < 45:
                    dispersed.append((row[0], val[:62]))
            elif kind == 'manual':
                manual_list.append((row[0], row[3][:50]))
    print("counts:", counts)
    print("char-type presence (per-word):", dict(typestat))
    print("\n== dispersed delete (covers whole alphabet) ==")
    for s in dispersed: print(s)
    print("\n== manual full ==")
    for s in manual_list: print(s)

def write_clean():
    """流式清洗并写回：只改 translation 字段，其余逐行原样；先写临时文件，备份后替换。"""
    import shutil, os
    tmp = MOD + '.clean.tmp'
    backup = MOD + '.原始备份.csv'
    orig = load_orig()
    n_rows = 0; n_changed = 0
    with open(MOD, encoding='utf-8', newline='') as fin, \
         open(tmp, 'w', encoding='utf-8', newline='') as fout:
        rr = csv.reader(fin)
        ww = csv.writer(fout, lineterminator='\n')
        ww.writerow(next(rr))
        for row in rr:
            n_rows += 1
            if len(row) >= 4:
                plan = plan_translation(row[0], row[3], orig)
                if plan:
                    row[3] = plan[1]
                    n_changed += 1
            ww.writerow(row)
    print(f"data rows={n_rows} changed={n_changed}")
    shutil.copy2(MOD, backup)
    os.replace(tmp, MOD)
    print("done. backup:", backup)

if __name__ == '__main__':
    if '--write' in sys.argv:
        write_clean()
    else:
        main()
