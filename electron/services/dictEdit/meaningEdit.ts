// 释义可逆拆解 / 重建（词库修改功能）
// 与 src/utils/translation.ts 的 parseMeanings 不同：展示管线会去重、清洗、推断词性（有损），
// 本模块用于"编辑后写回 stardict"，必须可逆：不去重、不推断词性、不截断文本，只做结构拆解。

export interface MeaningEntry {
  /** 词性标签（带点展示形态，如 'n.'、'vt.'；无词性为 ''） */
  pos: string;
  /** 该条释义原文（逐字保留） */
  text: string;
}

// 与 translation.ts 一致：只认标准词性标记，na. 等非标标记整体保留为文本
const VALID_POS_TAGS = new Set([
  'n', 'v', 'adj', 'adv', 'vt', 'vi', 'prep', 'conj', 'pron', 'art', 'num', 'int', 'interj', 'aux',
  'a', 's', 'r', 'c', 'u',
  'pl', 'sing', 'abbr',
  'ad', 'vbl', 'verb', 'auxv', 'linkv', 'modalv', 'det', 'quant', 'ordnumber',
  'pref', 'suf', 'suff', 'comb', 'phr', 'pn', 'pp', 'exclam',
]);

// 义项分隔符（与 parseMeanings/dedupeGlosses 的切分口径一致）
const GLOSS_SEP = /[；;，,、]/;

function normalizeNewlines(text: string): string {
  return text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

// 行首词性标签（"n. 苹果" → { pos:'n.', rest:'苹果' }）；非标词性返回 null（整体保留为文本）
function extractPos(segment: string): { pos: string; rest: string } | null {
  const m = segment.match(/^([a-zA-Z]+\.)\s*(.*)$/);
  if (!m) return null;
  const tag = m[1].replace('.', '');
  if (!VALID_POS_TAGS.has(tag.toLowerCase())) return null;
  return { pos: m[1], rest: m[2].trim() };
}

// 把一行按行内词性标签拆段，如 "废物vt. 废弃" → ["废物", "vt. 废弃"]
// 也处理 & / 、 , 连接多个词性的情况，如 "a. & n. xxx" → ["a.", "n. xxx"]
function splitInlinePos(line: string): string[] {
  const parts: string[] = [];
  let lastIndex = 0;
  const regex = /([^a-zA-Z\s]|(?:&|\/|、|,))(\s*)([a-zA-Z]+\.)\s*/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    const tag = match[3].replace('.', '');
    if (!VALID_POS_TAGS.has(tag.toLowerCase())) continue;

    const connector = match[1];
    if (/[&\\/、,]/.test(connector)) {
      parts.push(line.slice(lastIndex, match.index).trim());
      lastIndex = match.index + connector.length + match[2].length;
    } else {
      parts.push(line.slice(lastIndex, match.index + connector.length).trim());
      lastIndex = match.index + connector.length + match[2].length;
    }
  }
  parts.push(line.slice(lastIndex).trim());
  return parts.filter(Boolean);
}

/**
 * 把 stardict 的原始 translation 串可逆拆解为条目数组。
 * 不去重、不做破坏性清洗；仅剔除 PUA/控制字符与跳过【自定义】行（防御脏数据）。
 */
export function parseEditable(raw: string | null | undefined): MeaningEntry[] {
  const entries: MeaningEntry[] = [];
  if (!raw) return entries;

  const cleaned = normalizeNewlines(raw).replace(/[\uE000-\uF8FF\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  const lines = cleaned.split('\n').map(s => s.trim()).filter(Boolean);

  for (const line of lines) {
    // 备注覆盖追加的行不属于词库原始数据
    if (line.startsWith('【自定义】')) continue;

    for (const segment of splitInlinePos(line)) {
      const posMatch = extractPos(segment);
      const pos = posMatch ? posMatch.pos : '';
      const body = posMatch ? posMatch.rest : segment;

      for (const piece of body.split(GLOSS_SEP)) {
        const text = piece.trim();
        if (text) entries.push({ pos, text });
      }
    }
  }
  return entries;
}

/**
 * 把条目数组重建为 translation 串。
 * 连续同词性条目合并为一行："n. 苹果；苹果树\nv. 结实"；无词性行不带前缀。
 * 幂等：parseEditable(rebuildTranslation(parseEditable(x))) == parseEditable(x)。
 */
export function rebuildTranslation(entries: MeaningEntry[]): string {
  const lines: string[] = [];
  let i = 0;
  while (i < entries.length) {
    const pos = (entries[i].pos || '').trim();
    const texts: string[] = [];
    while (i < entries.length && (entries[i].pos || '').trim() === pos) {
      texts.push(entries[i].text.trim());
      i++;
    }
    lines.push(pos ? `${pos} ${texts.join('；')}` : texts.join('；'));
  }
  return lines.join('\n');
}

/** 可用词性选项（展示形态），供编辑下拉使用 */
export const MEANING_POS_OPTIONS: string[] = [
  'n.', 'v.', 'vt.', 'vi.', 'adj.', 'adv.', 'prep.', 'conj.', 'pron.', 'num.', 'int.', 'art.',
];
