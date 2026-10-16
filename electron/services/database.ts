import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { parse } from 'csv-parse';
import { LRUCache } from '../utils/cache';
import { ROOT_DIR, USER_DATA_DIR, ASSETS_DIR, resolveAssetPath } from '../utils/helpers';
import { phoneticToIpa } from './phoneticIpa';
import { ensureHistoryTables, HistoryConflictError, HistoryGoneError } from './dictEdit/history';

// Database instance type (extracted from the constructor)
type DatabaseInstance = InstanceType<typeof Database>;

// ==================== 路径解析 ====================
// 词库不可写时（packaged 安装目录只读）会迁移副本到 ASSETS_DIR，路径需可重解析
let MAIN_DB_PATH = resolveAssetPath('stardict.db');
const EXAMPLES_DB_PATH = resolveAssetPath('examples.db');
const STARDICT_CSV_PATH = resolveAssetPath('stardict.csv');
const LEMMA_PATH = resolveAssetPath('lemma.en.txt');
const WORDROOT_PATH = resolveAssetPath('wordroot.txt');
const RESEMBLE_PATH = resolveAssetPath('resemble.txt');

// ==================== 字段定义 ====================
const FIELDS = [
  'id', 'word', 'sw', 'phonetic', 'definition',
  'translation', 'pos', 'collins', 'oxford', 'tag', 'bnc', 'frq',
  'exchange', 'audio'
] as const;

// 字段名到索引的映射
const fieldIndex: Record<string, number> = {};
FIELDS.forEach((f, i) => { fieldIndex[f] = i; });

// ==================== 工具函数 ====================

function stripword(word: string): string {
  let result = '';
  for (const ch of word) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')) {
      result += ch;
    }
  }
  return result.toLowerCase();
}

function cleanPhonetic(phonetic: string | null | undefined): string {
  if (!phonetic) return '';
  // 统一标准化为标准 DJ 音标（IPA）：兼容 ECDICT 重拼式、半 IPA 与乱码，脏数据原样返回
  return phoneticToIpa(phonetic);
}

/**
 * 清洗 translation 字段中混入的音标碎片。
 * 数据源中部分词条把音标/变形信息拼进了释义字段：
 *   A:  "ˈmʌndɪ] n. 星期一"            → "n. 星期一"
 *   B:  "brought) [brɪŋ] vt.拿来"      → "vt.拿来"
 *   B2: "be come) [bɪˈkʌm] v.变得"    → "v.变得"
 *   A2: "jəu, 弱jə] pron.你的"        → "pron.你的"
 *   M:  "prep.…的；əv ˈɔf] prep.…的"  → "prep.…的；prep.…的"（全角；后的中段碎片）
 */
function cleanTranslation(translation: string | null | undefined): string {
  if (!translation) return '';
  const original = translation;
  let result = translation;

  // 个别词条叠了多层碎片（如 "音标] n.释义；音标] n.释义"），循环清洗到稳定，
  // 每轮都重新执行 B、A、M 三类规则，最多 4 轮防止异常数据死循环。
  for (let pass = 0; pass < 4; pass++) {
    const before = result;

    // B 类：开头是 "...变形) [音标] " 形态，括号前允许中文/空格/标点。
    // 方括号内容必须不含中文、数字、=、·、：（后几类是化学式/年份标记，
    // 如 "硫腙(…)[C6H5…]"、"[=ABC soil]"），长度 ≤40。
    // ] 后除空白外还可能夹私用区控制字符（数据源编码残留，如 \ue009）。
    result = result.replace(
      /^.{1,60}?\)\s*\[[^\[\]\u4e00-\u9fff0-9=·：]{1,40}\][\s\u0000-\u001f\ue000-\uefff]*/,
      ''
    );

    // A 类：开头是音标碎片 + "]"，"]" 后必须紧跟词性标签（英文单词+句点，
    // 允许 "modal v." 这类带空格的形式），避免误伤 "用]吸收…" 之类的中文残缺数据。
    // 允许碎片中出现极少量中文（如 "jəu, 弱jə]" 中的"弱"、"nei丁" 中的"丁"）。
    const m = result.match(/^([^\[\n]{1,40}?\])[\s\u0000-\u001f\ue000-\uefff]*(?=[a-zA-Z][a-zA-Z\s]{0,20}\.)/);
    if (m) {
      const prefix = m[1];
      const chineseCount = (prefix.match(/[\u4e00-\u9fff]/g) || []).length;
      if (chineseCount <= 2) {
        result = result.slice(m[0].length);
      }
    }

    // M 类：全角"；"之后混入的音标碎片（如 "prep.…的；əv; (US) ˈɔf] prep.…的"）。
    // 只认全角"；"作为起点（ASCII ";" 会出现在音标内部，如 "[kɔst; (US) kɔːst]"），
    // 碎片中不得含 "["（保护 "[医]" 等领域标签与含半角分音标的音标）。
    result = result.replace(
      /；([^\[\]\u4e00-\u9fff\n]{1,40}?\])[\s\u0000-\u001f\ue000-\uefff]*(?=[a-zA-Z][a-zA-Z\s]{0,20}\.)/g,
      '；'
    );

    if (result === before) break;
  }

  // 安全不变量：清洗不得把非空释义清空（遇到未覆盖的异常形态时保留原文）
  // PUA 私用区字符（编码残留，如 \ue10b 代替空格/换行）直接删除
  result = result.replace(/[\uE000-\uF8FF]/g, '');

    // 尾部外语乱码（阿拉伯/希伯来/韩文/泰文/天城文等编码残留），
    // 可能挂着 "/v." 空词性标签或单个拉丁字母，
    // 如 "…担子, 负担；/v.ؓؓ춡"、"…专门机构；Cٽ"、"…阿戈；ڡǰ"
    const tailGarbage =
      '[\\u0590-\\u06FF\\u0750-\\u077F\\u1100-\\u11FF\\u3130-\\u318F' +
      '\\uAC00-\\uD7AF\\u0900-\\u097F\\u0E00-\\u0E7F]';
    result = result.replace(
      new RegExp(
        '[\\s；;，,、/]*[a-zA-Z]{0,8}[\\u02B0-\\u02FF]?\\.?[\\x00-\\x1F\\x7F-\\x9F]*' + tailGarbage + '[\\s\\S]{0,12}$'
      ),
      ''
    );

    // 尾部"空词性标签"碎片：斜杠/分号后是词性标签，但标签后没有任何中英数释义，
    // 如 "…收受；/n."、"…/v.@"、"…/adv.һ"
    result = result.replace(
      /[\s；;，,、/]*[a-zA-Z]{1,8}\.\s*[^\u4e00-\u9fffa-zA-Z0-9]*$/,
      ''
    );

    // 收掉清洗后悬空的分隔符和反斜杠
    result = result.replace(/[\s；;，,、/\\]+$/, '').trim();

    if (result.trim() === '') return original;
  return result;
}

function recordToObj(record: any): any {
  if (!record) return null;
  const word: any = {};
  for (let i = 0; i < FIELDS.length; i++) {
    word[FIELDS[i]] = record[FIELDS[i]];
  }
  if (word['phonetic']) {
    word['phonetic'] = cleanPhonetic(word['phonetic']);
  }
  if (word['translation']) {
    word['translation'] = cleanTranslation(word['translation']);
  }
  return word;
}

// ==================== StarDict 词典 ====================

class StarDict {
  private db: DatabaseInstance | null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = null;
    this.initTables();
  }

  private initTables(): void {
    const sql = `
      CREATE TABLE IF NOT EXISTS "stardict" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL UNIQUE,
        "word" VARCHAR(64) COLLATE NOCASE NOT NULL UNIQUE,
        "sw" VARCHAR(64) COLLATE NOCASE NOT NULL,
        "phonetic" VARCHAR(64),
        "definition" TEXT,
        "translation" TEXT,
        "pos" VARCHAR(16),
        "collins" INTEGER DEFAULT(0),
        "oxford" INTEGER DEFAULT(0),
        "tag" VARCHAR(64),
        "bnc" INTEGER DEFAULT(NULL),
        "frq" INTEGER DEFAULT(NULL),
        "exchange" TEXT,
        "audio" TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "stardict_1" ON stardict (id);
      CREATE UNIQUE INDEX IF NOT EXISTS "stardict_2" ON stardict (word);
      CREATE INDEX IF NOT EXISTS "stardict_3" ON stardict (sw, word collate nocase);
      CREATE INDEX IF NOT EXISTS "sd_1" ON stardict (word collate nocase);
    `;

    try {
      const conn = new Database(this.dbPath);
      conn.exec(sql);
      conn.close();
    } catch (e) {
      // packaged 只读安装目录等场景建表失败不阻断启动（表已存在时无影响）
      console.warn('[DB] stardict 建表跳过（可能只读）:', (e as Error).message);
    }
  }

  private getDb(): DatabaseInstance {
    if (!this.db) {
      this.db = new Database(this.dbPath);
    }
    return this.db;
  }

  /** 查询单个单词，key 可以是 id(number) 或 word(string) */
  query(key: string | number): any {
    const db = this.getDb();
    let record: any;
    if (typeof key === 'number') {
      record = db.prepare('SELECT * FROM stardict WHERE id = ?').get(key);
    } else {
      record = db.prepare('SELECT * FROM stardict WHERE word = ?').get(key);
    }
    return recordToObj(record);
  }

  /** 按标签统计单词数量（空格分隔的 tag 字段精确匹配） */
  countByTag(tag: string): number {
    const db = this.getDb();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM stardict WHERE ' ' || tag || ' ' LIKE ?").get(`% ${tag} %`) as any;
    return row?.cnt || 0;
  }

  /** 按多个标签统计单词数量（OR 条件，空格分隔的 tag 字段精确匹配） */
  countByTags(tags: string[]): number {
    const db = this.getDb();
    const conditions = tags.map(() => "' ' || tag || ' ' LIKE ?").join(' OR ');
    const params = tags.map(t => `% ${t} %`);
    const row = db.prepare(`SELECT COUNT(*) as cnt FROM stardict WHERE ${conditions}`).get(...params) as any;
    return row?.cnt || 0;
  }

  /** 前缀匹配，返回 [id, word] 数组 */
  match(word: string, limit: number = 10): Array<[number, string]> {
    const db = this.getDb();
    const sql = 'SELECT id, word FROM stardict WHERE word >= ? ORDER BY word COLLATE NOCASE LIMIT ?';
    const rows = db.prepare(sql).all(word, limit) as Array<{ id: number; word: string }>;
    return rows.map((r: any) => [r.id, r.word] as [number, string]);
  }

  /**
   * 前缀匹配 + 智能排序
   * 排序优先级：用户考试类型 > 其他考试标签 > 柯林斯星级 > 词频
   */
  matchWithSort(
    prefix: string,
    limit: number = 10,
    userCategory: string = ''
  ): Array<{ id: number; word: string }> {
    const db = this.getDb();

    // 排序优先级判断使用原始输入（保留空格/连字符信息）
    const hasSpaceOrHyphen = prefix.includes(' ') || prefix.includes('-');

    // SQL 前缀匹配使用 trim 后的前缀，避免 "test " 只匹配词组
    const trimmedPrefix = prefix.trim();

    // 计算前缀上限（用于前缀范围查询）
    // 统一转小写，避免大写 Z 时上限字符 "[" 的 ASCII 码小于小写 z 导致漏词
    const lowerPrefix = trimmedPrefix.toLowerCase();
    const lastChar = lowerPrefix.charAt(lowerPrefix.length - 1);
    const prefixUpper = lowerPrefix
      ? lowerPrefix.slice(0, -1) + String.fromCharCode(lastChar.charCodeAt(0) + 1)
      : '';

    type MatchRow = { id: number; word: string; tag: string | null; collins: number | null; frq: number | null };

    // 两段取候选，避免高产前缀（app/uni/the 等）按字母序 LIMIT 截断时漏掉常用词：
    // 1) 前缀范围内的高质量词（有标签 / 柯林斯星级 / 有效词频）全部取出；
    // 2) 再按字母序补一批，保证精确短词与生僻词也能匹配。最后合并去重、统一排序。
    const highQualitySql = `
      SELECT id, word, tag, collins, frq
      FROM stardict
      WHERE word >= ? AND word < ?
        AND (COALESCE(tag, '') <> '' OR COALESCE(collins, 0) > 0 OR (frq IS NOT NULL AND frq > 0))
    `;
    const fillSql = `
      SELECT id, word, tag, collins, frq
      FROM stardict
      WHERE word >= ? AND word < ?
      ORDER BY word COLLATE NOCASE
      LIMIT 400
    `;
    const hqRows = db.prepare(highQualitySql).all(lowerPrefix, prefixUpper) as MatchRow[];
    const fillRows = db.prepare(fillSql).all(lowerPrefix, prefixUpper) as MatchRow[];
    const seenIds = new Set<number>();
    const rows: MatchRow[] = [];
    for (const r of [...hqRows, ...fillRows]) {
      if (!seenIds.has(r.id)) {
        seenIds.add(r.id);
        rows.push(r);
      }
    }

    const examTags: Record<string, number> = {
      'xx': 1, 'zk': 2, 'gk': 3, 'cet4': 4, 'cet6': 5,
      'tem4': 6, 'tem8': 7, 'ky': 8, 'toefl': 9, 'ielts': 10, 'gre': 11
    };

    const sortKey = (row: MatchRow): [number, number, number, number, number, number] => {
      const tagLower = (row.tag || '').toLowerCase();
      const isPhrase = row.word.includes(' ') || row.word.includes('-');

      // 1. 词组优先级：用户输入普通单词时单词优先，输入带空格/连字符时词组优先
      const phrasePriority = hasSpaceOrHyphen ? (isPhrase ? 0 : 1) : (isPhrase ? 1 : 0);

      // 2. 用户选择的考试类型（空格分隔精确匹配）
      const paddedTag = ' ' + tagLower + ' ';
      const userMatch = (userCategory && paddedTag.includes(' ' + userCategory + ' ')) ? 0 : 1;

      // 3. 是否带考试标签：有标签的常用词优先；并取该词最基础的考试层级（pri 越小越基础常用）
      let hasExamTag = 1;
      let bestTagPri = 99;
      if (tagLower) {
        for (const [etag, pri] of Object.entries(examTags)) {
          if (paddedTag.includes(' ' + etag + ' ')) {
            hasExamTag = 0;
            if (pri < bestTagPri) bestTagPri = pri;
          }
        }
      }

      // 4. 柯林斯星级（越高越好，取负使高星级排前面）
      const collinsScore = -(row.collins || 0);

      // 5. 词频排名（1 最常用，越小越靠前）；0/NULL 表示无语料数据，排末尾
      const frqScore = (row.frq && row.frq > 0) ? row.frq : 999999;

      return [phrasePriority, userMatch, hasExamTag, bestTagPri, collinsScore, frqScore];
    };

    rows.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] !== kb[i]) return ka[i] - kb[i];
      }
      return a.word.localeCompare(b.word);
    });

    return rows.slice(0, limit).map((row: any) => ({
      id: row.id,
      word: row.word
    }));
  }

  /** 按中文释义模糊搜索，返回单词、释义 */
  searchByChinese(keyword: string, limit: number = 50): Array<{ id: number; word: string; translation: string }> {
    const db = this.getDb();
    const sql = `
      SELECT id, word, translation
      FROM stardict
      WHERE translation LIKE ?
      ORDER BY
        -- frq=0/NULL 均视为无语料数据排末尾，避免生僻变形（frq=0）被当成最常用词
        CASE WHEN frq IS NOT NULL AND frq > 0 THEN frq ELSE 999999 END ASC,
        collins DESC,
        CASE WHEN COALESCE(tag, '') <> '' THEN 0 ELSE 1 END,
        LENGTH(word) ASC
      LIMIT ?
    `;
    const rows = db.prepare(sql).all(`%${keyword}%`, limit) as any[];
    return rows.map((r: any) => ({
      id: r.id,
      word: r.word,
      translation: cleanTranslation(r.translation)
    }));
  }

  /** 批量查询，keys 可以是 id 或 word 的混合数组 */
  queryBatch(keys: Array<string | number>): any[] {
    if (!keys) return [];
    if (keys.length === 0) return [];

    const db = this.getDb();
    const queries: string[] = [];
    const params: any[] = [];

    for (const key of keys) {
      if (typeof key === 'number') {
        queries.push('id = ?');
        params.push(key);
      } else if (key !== null && key !== undefined) {
        queries.push('word = ?');
        params.push(key);
      }
    }

    const sql = 'SELECT * FROM stardict WHERE ' + queries.join(' OR ');

    const queryWord: Record<string, any> = {};
    const queryId: Record<number, any> = {};

    const rows = db.prepare(sql).all(...params) as any[];
    for (const row of rows) {
      const obj = recordToObj(row);
      queryWord[obj.word.toLowerCase()] = obj;
      queryId[obj.id] = obj;
    }

    return keys.map(key => {
      if (typeof key === 'number') {
        return queryId[key] || null;
      } else if (key !== null && key !== undefined) {
        return queryWord[key.toLowerCase()] || null;
      }
      return null;
    });
  }

  /** 单词总数 */
  count(): number {
    const db = this.getDb();
    const row = db.prepare('SELECT COUNT(*) as cnt FROM stardict').get() as { cnt: number };
    return row.cnt;
  }

  /** 分页获取所有单词（用于离线发音包批量下载） */
  getAllWords(limit: number = -1, offset: number = 0): string[] {
    const db = this.getDb();
    let sql = 'SELECT word FROM stardict ORDER BY word COLLATE NOCASE';
    const params: any[] = [];
    if (limit > 0) {
      sql += ' LIMIT ? OFFSET ?';
      params.push(limit, offset);
    }
    const rows = db.prepare(sql).all(...params) as Array<{ word: string }>;
    return rows.map(r => r.word);
  }

  /** 当前连接的数据库文件路径 */
  getDbPath(): string {
    return this.dbPath;
  }

  /** 原始 better-sqlite3 连接（供跨库事务等高级操作） */
  getRawDb(): DatabaseInstance {
    return this.getDb();
  }

  /**
   * 更新某词的 translation（词库修改功能；只动 translation 字段）。
   * 抛 SQLITE_READONLY 等错误由调用方做只读迁移兜底。
   */
  updateTranslation(id: number, translation: string): void {
    const db = this.getDb();
    db.prepare('UPDATE stardict SET translation = ? WHERE id = ?').run(translation, id);
  }

  /** 迁移只读词库后重连到新路径 */
  reopen(newPath: string): void {
    this.close();
    this.dbPath = newPath;
    this.db = null;
    this.initTables();
  }

  /** 关闭数据库连接 */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// ==================== 例句查询 ====================

const examplesCache = new LRUCache<any[]>(500);

function findExamplesForWord(word: string): any[] {
  const targetWord = word.toLowerCase();

  const cached = examplesCache.get(targetWord);
  if (cached !== undefined) return cached;

  const examples: any[] = [];

  try {
    if (!fs.existsSync(EXAMPLES_DB_PATH)) return examples;

    const conn = new Database(EXAMPLES_DB_PATH, { readonly: true });
    const stmt = conn.prepare(`
      SELECT s.id, s.text as eng_text, t.cmn_id, s_cmn.text as cmn_text
      FROM sentences s
      JOIN word_examples w ON s.id = w.sentence_id
      JOIN translations t ON s.id = t.eng_id
      JOIN sentences s_cmn ON t.cmn_id = s_cmn.id
      WHERE w.word = ?
      LIMIT 50
    `);
    const rows = stmt.all(targetWord) as any[];

    for (const row of rows) {
      examples.push({
        id: String(row.id),
        lang: 'eng',
        text: row.eng_text,
        translation: row.cmn_text
      });
    }

    conn.close();
  } catch (e) {
    console.error('例句查询失败:', e);
  }

  examplesCache.put(targetWord, examples);
  return examples;
}

// ==================== LemmaDB 词干数据库 ====================

class LemmaDB {
  private lemmaMap: Record<string, string> = {};   // 词形 -> 词干
  private inflections: Record<string, string[]> = {}; // 词干 -> 词形列表

  constructor(filePath?: string) {
    const fp = filePath || LEMMA_PATH;
    this.load(fp);
  }

  private load(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      console.warn(`警告：未找到文件 ${filePath}`);
      return;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(';')) continue;

      const pos = trimmed.indexOf('->');
      if (pos <= 0) continue;

      const lemmaPart = trimmed.substring(0, pos).trim();
      const inflectionPart = trimmed.substring(pos + 2).trim();

      // 提取词干（去掉 /词频 部分）
      let lemma = lemmaPart;
      const slashIdx = lemma.indexOf('/');
      if (slashIdx >= 0) {
        lemma = lemma.substring(0, slashIdx);
      }
      lemma = lemma.toLowerCase();

      // 提取词形变化列表
      const inflectionsList = inflectionPart.split(',')
        .map(w => w.split('/')[0].trim().toLowerCase())
        .filter(w => w.length > 0);

      this.inflections[lemma] = inflectionsList;

      for (const w of inflectionsList) {
        this.lemmaMap[w] = lemma;
      }
      // 词干本身也指向自己
      this.lemmaMap[lemma] = lemma;
    }
  }

  /** 获取单词的词干 */
  getLemma(word: string): string | null {
    return this.lemmaMap[word.toLowerCase()] || null;
  }

  /** 获取词干的所有词形变化 */
  getInflections(lemma: string): string[] {
    return this.inflections[lemma.toLowerCase()] || [];
  }

  /** 查找单词的所有相关词形（包括词干和所有变体，排除自身） */
  findRelatedForms(word: string): string[] {
    const wordLower = word.toLowerCase();
    const lemma = this.getLemma(wordLower);
    if (!lemma) return [];

    let forms = this.getInflections(lemma);
    // 确保词干也在列表中
    if (!forms.includes(lemma)) {
      forms = [lemma, ...forms];
    }
    // 排除查询词本身
    return forms.filter(w => w !== wordLower);
  }
}

// ==================== WordRootDB 词根数据库 ====================

class WordRootDB {
  private rootData: Record<string, any> = {};       // 词根/词缀 -> 详细信息
  private wordToRoots: Record<string, string[]> = {}; // 单词 -> 相关词根列表

  constructor(filePath?: string) {
    const fp = filePath || WORDROOT_PATH;
    this.load(fp);
  }

  private load(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      console.warn(`警告：未找到文件 ${filePath}`);
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.rootData = JSON.parse(content);

      // 构建单词到词根的反向索引
      for (const [root, info] of Object.entries(this.rootData)) {
        if (info.example) {
          for (const word of info.example) {
            const wordLower = word.toLowerCase();
            if (!this.wordToRoots[wordLower]) {
              this.wordToRoots[wordLower] = [];
            }
            this.wordToRoots[wordLower].push(root);
          }
        }
      }
    } catch (e) {
      console.error(`加载词根文件 wordroot.txt 出错: ${e}`);
    }
  }

  /** 获取单词相关的词根 */
  getRootsForWord(word: string): string[] {
    return this.wordToRoots[word.toLowerCase()] || [];
  }

  /** 获取词根的详细信息 */
  getRootInfo(root: string): any {
    return this.rootData[root] || null;
  }
}

// ==================== ResembleDB 形近词数据库 ====================

interface ResembleGroup {
  words: string[];
  explanation: string[];
}

class ResembleDB {
  private groups: ResembleGroup[] = [];
  private wordToGroups: Record<string, number[]> = {};  // 单词(小写) -> 所属词组索引列表
  private wordVariants: Record<string, Set<string>> = {}; // 单词(小写) -> 原始大小写集合

  constructor(filePath?: string) {
    const fp = filePath || RESEMBLE_PATH;
    this.load(fp);
  }

  private load(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      console.warn(`警告：未找到文件 ${filePath}`);
      return;
    }

    let currentGroup: ResembleGroup | null = null;

    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();

      if (trimmed.startsWith('%')) {
        // 新词组开始
        if (currentGroup) {
          this.groups.push(currentGroup);
        }

        const wordsStr = trimmed.substring(1).trim();
        const words = wordsStr.split(',').map(w => w.trim()).filter(w => w.length > 0);
        currentGroup = { words, explanation: [] };

        // 为每个单词建立索引
        for (const word of words) {
          const wordLower = word.toLowerCase();
          if (!this.wordToGroups[wordLower]) {
            this.wordToGroups[wordLower] = [];
          }
          this.wordToGroups[wordLower].push(this.groups.length);

          if (!this.wordVariants[wordLower]) {
            this.wordVariants[wordLower] = new Set();
          }
          this.wordVariants[wordLower].add(word);
        }
      } else if (currentGroup && trimmed) {
        currentGroup.explanation.push(trimmed);
      }
    }

    // 添加最后一个词组
    if (currentGroup) {
      this.groups.push(currentGroup);
    }
  }

  /** 获取单词的形近词/同义词 */
  getSimilarWords(word: string): string[] {
    const wordLower = word.toLowerCase();
    const groupIndices = this.wordToGroups[wordLower] || [];

    const similarWords: string[] = [];
    for (const idx of groupIndices) {
      if (idx < this.groups.length) {
        const group = this.groups[idx];
        const others = group.words.filter(w => w !== word);
        similarWords.push(...others);
      }
    }

    // 去重
    return [...new Set(similarWords)];
  }

  /** 获取单词所属的词组详细信息 */
  getGroupInfo(word: string): ResembleGroup[] {
    const wordLower = word.toLowerCase();
    const groupIndices = this.wordToGroups[wordLower] || [];

    return groupIndices
      .filter(idx => idx < this.groups.length)
      .map(idx => ({ ...this.groups[idx] }));
  }
}

// ==================== 增强信息 ====================

function getWordEnhancedInfo(word: string): any {
  const lemmaDB = getLemmaDB();
  const wordrootDB = getWordRootDB();
  const resembleDB = getResembleDB();

  const wordLower = word.toLowerCase();

  const info: any = {
    word,
    lemma: lemmaDB.getLemma(wordLower),
    relatedForms: lemmaDB.findRelatedForms(word),
    roots: [] as any[],
    similar_words: resembleDB.getSimilarWords(word),
    resemble_groups: resembleDB.getGroupInfo(word)
  };

  const roots = wordrootDB.getRootsForWord(wordLower);
  for (const root of roots) {
    const rootInfo = wordrootDB.getRootInfo(root);
    if (rootInfo) {
      info.roots.push({ root, info: rootInfo });
    }
  }

  return info;
}

// ==================== 单例实例 ====================

let _mainDb: StarDict | null = null;
let _lemmaDB: LemmaDB | null = null;
let _wordrootDB: WordRootDB | null = null;
let _resembleDB: ResembleDB | null = null;

// ==================== 从 CSV 生成词典 ====================

/** 检查词典数据库是否为空或不存在 */
function isDbEmpty(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return true;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) as cnt FROM stardict').get() as { cnt: number } | undefined;
    db.close();
    return !row || row.cnt === 0;
  } catch {
    return true;
  }
}

/** 首次启动时从 CSV 合并生成 stardict.db（流式解析，避免内存爆炸） */
function buildStardictDbFromCsvs(outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log('首次启动，正在从 CSV 生成词典数据库，请稍候...');
    const t0 = Date.now();

    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    const db = new Database(outputPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS "stardict" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL UNIQUE,
        "word" VARCHAR(64) COLLATE NOCASE NOT NULL UNIQUE,
        "sw" VARCHAR(64) COLLATE NOCASE NOT NULL,
        "phonetic" VARCHAR(64),
        "definition" TEXT,
        "translation" TEXT,
        "pos" VARCHAR(16),
        "collins" INTEGER DEFAULT(0),
        "oxford" INTEGER DEFAULT(0),
        "tag" VARCHAR(64),
        "bnc" INTEGER DEFAULT(NULL),
        "frq" INTEGER DEFAULT(NULL),
        "exchange" TEXT,
        "audio" TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "stardict_1" ON stardict (id);
      CREATE UNIQUE INDEX IF NOT EXISTS "stardict_2" ON stardict (word);
      CREATE INDEX IF NOT EXISTS "stardict_3" ON stardict (sw, word collate nocase);
      CREATE INDEX IF NOT EXISTS "sd_1" ON stardict (word collate nocase);
    `);

    const insert = db.prepare(`
      INSERT INTO stardict (word, sw, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange, audio)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertBatch = db.transaction((rows: any[][]) => {
      for (const row of rows) {
        insert.run(...row);
      }
    });

    const csvFiles = [
      { path: STARDICT_CSV_PATH, name: '词典 stardict.csv' }
    ];

    const seen = new Set<string>();
    let totalImported = 0;

    function processFile(index: number): void {
      if (index >= csvFiles.length) {
        db.close();
        console.log(`词典数据库生成完成：共 ${totalImported} 条 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        resolve();
        return;
      }

      const csvFile = csvFiles[index];
      if (!fs.existsSync(csvFile.path)) {
        console.log(`跳过 ${csvFile.name}：文件不存在`);
        processFile(index + 1);
        return;
      }

      console.log(`正在导入 ${csvFile.name}...`);
      const tFile = Date.now();
      let fileCount = 0;
      const batch: any[][] = [];
      const BATCH_SIZE = 1000;

      const parser = parse({
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        trim: true
      });

      function flushBatch(): void {
        if (batch.length === 0) return;
        insertBatch(batch);
        batch.length = 0;
      }

      fs.createReadStream(csvFile.path, { encoding: 'utf-8' })
        .pipe(parser)
        .on('data', (row: Record<string, string>) => {
          const word = row.word;
          if (!word) return;

          const lower = word.toLowerCase();
          if (seen.has(lower)) return;
          seen.add(lower);

          batch.push([
            word,
            stripword(word),
            row.phonetic || '',
            row.definition || '',
            row.translation || '',
            row.pos || '',
            parseInt(row.collins) || 0,
            parseInt(row.oxford) || 0,
            row.tag || '',
            row.bnc ? parseInt(row.bnc) : null,
            row.frq ? parseInt(row.frq) : null,
            row.exchange || '',
            row.audio || ''
          ]);

          fileCount++;
          totalImported++;

          if (batch.length >= BATCH_SIZE) {
            flushBatch();
          }

          if (fileCount % 10000 === 0) {
            console.log(`  ${csvFile.name}: 已导入 ${fileCount} 条...`);
          }
        })
        .on('end', () => {
          flushBatch();
          console.log(`${csvFile.name} 导入完成：${fileCount} 条 (${((Date.now() - tFile) / 1000).toFixed(1)}s)`);
          processFile(index + 1);
        })
        .on('error', (err: any) => {
          console.error(`${csvFile.name} 导入失败:`, err);
          db.close();
          reject(err);
        });
    }

    processFile(0);
  });
}

// ==================== 用户词典（独立存储，可编辑） ====================
// 用户自建 / 自定义词条，独立于 stardict.db（ECDICT 只读），资源升级不覆盖。
// word_type: noun/adj/verb/adv/phrase/idiom/sentence
// is_custom: 1=纯自建词；0=针对 stardict 词的自定义释义
// override_mode: merge=合并显示；replace=替换 stardict 释义
// hidden: 隐藏标记（stardict 词删除=置 1，可恢复；自建词删除=真删）

const USER_DB_PATH = path.join(USER_DATA_DIR, 'user_dict.db');

const USER_WORD_TYPES = ['noun', 'adj', 'verb', 'adv', 'phrase', 'idiom', 'sentence'] as const;

function normalizeUserWord(word: string): string {
  return String(word || '').trim().toLowerCase();
}

class UserDict {
  private db: DatabaseInstance | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.initTables();
  }

  private initTables(): void {
    const conn = new Database(this.dbPath);
    conn.exec(`
      CREATE TABLE IF NOT EXISTS user_dict (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word TEXT NOT NULL,
        word_display TEXT NOT NULL,
        word_type TEXT NOT NULL DEFAULT 'phrase'
          CHECK(word_type IN ('noun','adj','verb','adv','phrase','idiom','sentence')),
        translation TEXT NOT NULL DEFAULT '',
        definition TEXT NOT NULL DEFAULT '',
        example TEXT NOT NULL DEFAULT '',
        example_trans TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        is_custom INTEGER NOT NULL DEFAULT 1,
        override_mode TEXT NOT NULL DEFAULT 'merge'
          CHECK(override_mode IN ('merge','replace')),
        hidden INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime')),
        updated_at TEXT DEFAULT (datetime('now','localtime'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_dict_word ON user_dict(word);
      CREATE INDEX IF NOT EXISTS idx_user_dict_hidden ON user_dict(hidden);
    `);
    // 词库修改版本留痕表（与 user_dict 同库，备份不含）
    ensureHistoryTables(conn);
    conn.close();
  }

  private getDb(): DatabaseInstance {
    if (!this.db) {
      this.db = new Database(this.dbPath);
    }
    return this.db;
  }

  /** 原始连接（供版本留痕等只读查询使用） */
  getRawDb(): DatabaseInstance {
    return this.getDb();
  }

  /** 按归一化 word 查询（含隐藏条目） */
  getByWord(word: string): any {
    const db = this.getDb();
    return db.prepare('SELECT * FROM user_dict WHERE word = ?').get(normalizeUserWord(word)) || null;
  }

  /** 按 id 查询 */
  getById(id: number): any {
    const db = this.getDb();
    return db.prepare('SELECT * FROM user_dict WHERE id = ?').get(id) || null;
  }

  /** 列表查询：关键词（word/翻译模糊）+ 类型筛选 + 是否含隐藏 */
  list(opts: { q?: string; type?: string; includeHidden?: boolean; limit?: number; offset?: number } = {}): { items: any[]; total: number } {
    const db = this.getDb();
    const where: string[] = [];
    const params: any[] = [];
    if (!opts.includeHidden) where.push('hidden = 0');
    if (opts.type && (USER_WORD_TYPES as readonly string[]).includes(opts.type)) {
      where.push('word_type = ?');
      params.push(opts.type);
    }
    if (opts.q && opts.q.trim()) {
      where.push('(word LIKE ? OR word_display LIKE ? OR translation LIKE ?)');
      const like = `%${opts.q.trim().toLowerCase()}%`;
      params.push(like, like, `%${opts.q.trim()}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM user_dict ${whereSql}`).get(...params) as any).c;
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    const items = db
      .prepare(`SELECT * FROM user_dict ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    return { items, total };
  }

  /** 新增词条；word 冲突时抛错（由调用方决定覆盖或报 409） */
  insert(data: {
    word: string; word_display?: string; word_type?: string; translation: string;
    definition?: string; example?: string; example_trans?: string; tags?: string;
    is_custom?: number; override_mode?: string; hidden?: number;
  }): any {
    const db = this.getDb();
    const word = normalizeUserWord(data.word);
    if (!word) throw new Error('词条不能为空');
    if (!String(data.translation || '').trim()) throw new Error('翻译不能为空');
    const wordType = (USER_WORD_TYPES as readonly string[]).includes(data.word_type || '')
      ? data.word_type : 'phrase';
    const overrideMode = data.override_mode === 'replace' ? 'replace' : 'merge';
    const info = db.prepare(`
      INSERT INTO user_dict (word, word_display, word_type, translation, definition, example, example_trans, tags, is_custom, override_mode, hidden)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      word,
      data.word_display || String(data.word || '').trim(),
      wordType,
      String(data.translation).trim(),
      data.definition || '',
      data.example || '',
      data.example_trans || '',
      data.tags || '',
      data.is_custom ?? 1,
      overrideMode,
      data.hidden ?? 0
    );
    return this.getById(Number(info.lastInsertRowid));
  }

  /** 更新词条（部分字段） */
  update(id: number, data: Partial<{
    word_display: string; word_type: string; translation: string; definition: string;
    example: string; example_trans: string; tags: string; override_mode: string; hidden: number;
  }>): any {
    const db = this.getDb();
    const cur = this.getById(id);
    if (!cur) throw new Error('词条不存在');
    const fields: string[] = [];
    const params: any[] = [];
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); params.push(val); };
    if (data.word_display !== undefined) set('word_display', data.word_display);
    if (data.word_type !== undefined) {
      if (!(USER_WORD_TYPES as readonly string[]).includes(data.word_type)) throw new Error('无效的词性类型');
      set('word_type', data.word_type);
    }
    if (data.translation !== undefined) {
      if (!String(data.translation).trim()) throw new Error('翻译不能为空');
      set('translation', String(data.translation).trim());
    }
    if (data.definition !== undefined) set('definition', data.definition);
    if (data.example !== undefined) set('example', data.example);
    if (data.example_trans !== undefined) set('example_trans', data.example_trans);
    if (data.tags !== undefined) set('tags', data.tags);
    if (data.override_mode !== undefined) set('override_mode', data.override_mode === 'replace' ? 'replace' : 'merge');
    if (data.hidden !== undefined) set('hidden', data.hidden ? 1 : 0);
    if (fields.length === 0) return cur;
    set('updated_at', `datetime('now','localtime')`);
    // updated_at 直接拼 SQL 函数
    const lastIdx = fields.length - 1;
    fields[lastIdx] = 'updated_at = datetime(\'now\',\'localtime\')';
    params.pop();
    params.push(id);
    db.prepare(`UPDATE user_dict SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.getById(id);
  }

  /** 删除词条（真删，返回是否有删除） */
  deleteById(id: number): boolean {
    const db = this.getDb();
    const info = db.prepare('DELETE FROM user_dict WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** 设置 / 取消隐藏 */
  setHidden(id: number, hidden: boolean): any {
    return this.update(id, { hidden: hidden ? 1 : 0 });
  }

  /**
   * 按 word 隐藏/恢复：无记录时插入纯隐藏记录（is_custom 由调用方按 stardict 是否存在给定）。
   * 隐藏记录 translation 允许为空（仅作标记，不参与释义显示）。
   */
  setHiddenByWord(word: string, hidden: boolean, isCustom: number = 0): any {
    const db = this.getDb();
    const w = normalizeUserWord(word);
    if (!w) throw new Error('词条不能为空');
    const cur = this.getByWord(w);
    if (cur) {
      db.prepare('UPDATE user_dict SET hidden = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?')
        .run(hidden ? 1 : 0, cur.id);
      return this.getById(cur.id);
    }
    if (!hidden) return null;
    db.prepare(`
      INSERT INTO user_dict (word, word_display, word_type, translation, hidden, is_custom)
      VALUES (?, ?, ?, '', 1, ?)
    `).run(w, String(word).trim(), 'phrase', isCustom ? 1 : 0);
    return this.getByWord(w);
  }

  /** 导出全部（含隐藏），供备份与 CSV */
  exportAll(): any[] {
    const db = this.getDb();
    return db.prepare('SELECT * FROM user_dict ORDER BY id').all();
  }

  /** 中文释义搜索（翻译模糊匹配，过滤隐藏） */
  searchByTranslation(keyword: string, limit: number = 50): any[] {
    const db = this.getDb();
    const rows = db
      .prepare('SELECT * FROM user_dict WHERE hidden = 0 AND translation LIKE ? ORDER BY LENGTH(word) ASC, id DESC LIMIT ?')
      .all(`%${String(keyword || '').trim()}%`, limit);
    return rows;
  }

  /** 批量 upsert（按 word 幂等）；返回 {added, updated} */
  upsertMany(rows: Array<Record<string, any>>): { added: number; updated: number } {
    const db = this.getDb();
    let added = 0, updated = 0;
    const insertSql = `
      INSERT INTO user_dict (word, word_display, word_type, translation, definition, example, example_trans, tags, is_custom, override_mode, hidden)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(word) DO UPDATE SET
        word_display = excluded.word_display,
        word_type = excluded.word_type,
        translation = excluded.translation,
        definition = excluded.definition,
        example = excluded.example,
        example_trans = excluded.example_trans,
        tags = excluded.tags,
        is_custom = excluded.is_custom,
        override_mode = excluded.override_mode,
        hidden = excluded.hidden,
        updated_at = datetime('now','localtime')
    `;
    const stmt = db.prepare(insertSql);
    const tx = db.transaction((items: Array<Record<string, any>>) => {
      for (const r of items) {
        const word = normalizeUserWord(r.word);
        if (!word) continue;
        const exists = db.prepare('SELECT 1 FROM user_dict WHERE word = ?').get(word);
        stmt.run(
          word,
          r.word_display || r.word || word,
          (USER_WORD_TYPES as readonly string[]).includes(r.word_type) ? r.word_type : 'phrase',
          String(r.translation || '').trim(),
          r.definition || '',
          r.example || '',
          r.example_trans || '',
          r.tags || '',
          r.is_custom ?? 1,
          r.override_mode === 'replace' ? 'replace' : 'merge',
          r.hidden ? 1 : 0
        );
        if (exists) updated++; else added++;
      }
    });
    tx(rows);
    return { added, updated };
  }
}

let _userDb: UserDict | null = null;

function getUserDb(): UserDict {
  if (!_userDb) {
    _userDb = new UserDict(USER_DB_PATH);
  }
  return _userDb;
}

// ==================== 公共 API ====================

/** 当前 stardict.db 路径（只读迁移后会变为 ASSETS_DIR 副本） */
function getMainDbPath(): string {
  return MAIN_DB_PATH;
}

function isReadonlyError(e: unknown): boolean {
  const msg = String((e as Error)?.message || e);
  return /READONLY|read-only|EROFS|EACCES/i.test(msg);
}

/**
 * 只读兜底：把 stardict.db 复制到 ASSETS_DIR（resolveAssetPath 优先该目录），
 * 重连主词典后由调用方重试写入。下次启动自动命中用户副本。
 */
function migrateStardictToAssets(): string {
  const main = _mainDb;
  const src = main ? main.getDbPath() : MAIN_DB_PATH;
  const dst = path.join(ASSETS_DIR, 'stardict.db');
  if (path.resolve(src) === path.resolve(dst)) {
    throw new Error('词库文件不可写');
  }
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  if (main) main.close();
  const tmp = dst + '.tmp';
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
  MAIN_DB_PATH = dst;
  if (main) main.reopen(dst);
  else _mainDb = new StarDict(dst);
  console.log(`[DB] 词库已迁移到用户目录: ${dst}`);
  return dst;
}

/**
 * 跨库原子事务：stardict 连接 ATTACH user_dict.db（别名 hist），
 * 事务内完成「留痕写入 + 词条更新 + 版本指针」。只读失败自动迁移副本重试一次。
 */
function runDictEditTx<T>(fn: (db: DatabaseInstance, histSchema: string) => T): T {
  const main = _mainDb;
  if (!main) throw new Error('词典未初始化');

  const attempt = (conn: DatabaseInstance): T => {
    conn.exec(`ATTACH DATABASE '${USER_DB_PATH.replace(/'/g, "''")}' AS hist`);
    try {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(conn, 'hist');
        conn.exec('COMMIT');
        return result;
      } catch (e) {
        try { conn.exec('ROLLBACK'); } catch { /* ignore */ }
        throw e;
      }
    } finally {
      try { conn.exec('DETACH DATABASE hist'); } catch { /* ignore */ }
    }
  };

  try {
    return attempt(main.getRawDb());
  } catch (e) {
    if (isReadonlyError(e)) {
      migrateStardictToAssets();
      return attempt(_mainDb!.getRawDb());
    }
    throw e;
  }
}

/** 初始化词典数据库 */
async function initDatabases(): Promise<void> {
  if (isDbEmpty(MAIN_DB_PATH)) {
    await buildStardictDbFromCsvs(MAIN_DB_PATH);
  }

  console.log('正在初始化词典...');
  const t0 = Date.now();
  _mainDb = new StarDict(MAIN_DB_PATH);
  const count = _mainDb.count();
  console.log(`词典准备就绪：${count} 个单词 (${((Date.now() - t0) / 1000).toFixed(3)}s)`);
}

/** 获取词典数据库实例 */
function getMainDb(): StarDict | null {
  return _mainDb;
}

/** 获取例句数据库路径（直接返回路径，由调用方自行连接） */
function getExamplesDbPath(): string {
  return EXAMPLES_DB_PATH;
}

/** 获取例句数据库连接 */
function getExamplesDb(): DatabaseInstance | null {
  if (!fs.existsSync(EXAMPLES_DB_PATH)) return null;
  return new Database(EXAMPLES_DB_PATH, { readonly: true });
}

function getLemmaDB(): LemmaDB {
  if (!_lemmaDB) {
    _lemmaDB = new LemmaDB();
  }
  return _lemmaDB;
}

function getWordRootDB(): WordRootDB {
  if (!_wordrootDB) {
    _wordrootDB = new WordRootDB();
  }
  return _wordrootDB;
}

function getResembleDB(): ResembleDB {
  if (!_resembleDB) {
    _resembleDB = new ResembleDB();
  }
  return _resembleDB;
}

export {
  StarDict,
  LemmaDB,
  WordRootDB,
  ResembleDB,
  UserDict,
  USER_WORD_TYPES,
  normalizeUserWord,
  initDatabases,
  getLemmaDB,
  getWordRootDB,
  getResembleDB,
  getUserDb,
  getWordEnhancedInfo,
  findExamplesForWord,
  getMainDb,
  getMainDbPath,
  runDictEditTx,
  HistoryConflictError,
  HistoryGoneError,
  getExamplesDb,
  getExamplesDbPath,
  buildStardictDbFromCsvs,
  cleanTranslation,
  cleanPhonetic
};