// 词库修改版本留痕（Word/WPS 式撤销 / 重做 / 版本恢复）
// 表存放在 user_dict.db；写入经调用方的跨库事务（stardict 连接 ATTACH 后以 schema='hist' 调用）。
import Database from 'better-sqlite3';
import { MeaningEntry } from './meaningEdit';

type Db = InstanceType<typeof Database>;

/** 乐观锁冲突（expected_head_seq 与服务端不一致） */
export class HistoryConflictError extends Error {
  constructor(message = '版本状态已变化，请刷新后重试') {
    super(message);
    this.name = 'HistoryConflictError';
  }
}

/** 无目标版本可操作（无可撤销 / 无可重做 / 版本号非法） */
export class HistoryGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryGoneError';
  }
}

export interface HistoryState {
  word_id: number;
  head_seq: number;   // 当前生效版本；0 = 从未修改（词库原始数据）
  latest_seq: number; // 最新版本号
  can_undo: boolean;
  can_redo: boolean;
}

export interface HistoryItem {
  seq: number;        // 0 = 原始词库数据（隐式版本）
  action: string;
  summary: string;
  created_at: string;
  is_head: boolean;
  after: MeaningEntry[]; // 该版本的释义快照（seq=0 取最早一行的 before）
}

const RETENTION_DAYS = 14;
const MAX_VERSIONS_PER_WORD = 200;

function table(schema: string, name: string): string {
  return schema === 'main' ? name : `${schema}.${name}`;
}

/** 建表（user_dict.db 内；schema='hist' 时经 ATTACH 在事务外调用） */
export function ensureHistoryTables(db: Db, schema = 'main'): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table(schema, 'dict_edit_history')} (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      word        TEXT NOT NULL,
      word_id     INTEGER NOT NULL,
      seq         INTEGER NOT NULL,
      action      TEXT NOT NULL,
      summary     TEXT NOT NULL DEFAULT '',
      before_json TEXT NOT NULL,
      after_json  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(word, seq)
    );
    CREATE INDEX IF NOT EXISTS ${schema === 'main' ? '' : schema + '.'}idx_hist_word_seq ON ${table(schema, 'dict_edit_history')}(word, seq);
    CREATE INDEX IF NOT EXISTS ${schema === 'main' ? '' : schema + '.'}idx_hist_created ON ${table(schema, 'dict_edit_history')}(created_at);
    CREATE TABLE IF NOT EXISTS ${table(schema, 'dict_edit_state')} (
      word        TEXT PRIMARY KEY,
      word_id     INTEGER NOT NULL,
      head_seq    INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);
}

function normalizeWord(word: string): string {
  return (word || '').trim().toLowerCase();
}

/** 读取版本状态（无记录 = head 0） */
export function getState(db: Db, word: string, schema = 'main'): HistoryState {
  const w = normalizeWord(word);
  const row = db.prepare(`SELECT word_id, head_seq FROM ${table(schema, 'dict_edit_state')} WHERE word = ?`).get(w) as any;
  const latest = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM ${table(schema, 'dict_edit_history')} WHERE word = ?`).get(w) as any;
  const head = row?.head_seq ?? 0;
  const latestSeq = latest?.m ?? 0;
  return {
    word_id: row?.word_id ?? 0,
    head_seq: head,
    latest_seq: latestSeq,
    can_undo: head > 0,
    can_redo: head < latestSeq,
  };
}

function readVersion(db: Db, word: string, seq: number, schema: string): { before: MeaningEntry[]; after: MeaningEntry[]; action: string; summary: string } | null {
  const row = db.prepare(
    `SELECT action, summary, before_json, after_json FROM ${table(schema, 'dict_edit_history')} WHERE word = ? AND seq = ?`
  ).get(normalizeWord(word), seq) as any;
  if (!row) return null;
  return {
    action: row.action,
    summary: row.summary,
    before: JSON.parse(row.before_json) as MeaningEntry[],
    after: JSON.parse(row.after_json) as MeaningEntry[],
  };
}

/** 当前生效版本的释义快照（head=0 时取最早一行的 before，即词库原始数据） */
export function currentEntries(db: Db, word: string, schema = 'main'): MeaningEntry[] | null {
  const st = getState(db, word, schema);
  if (st.head_seq === 0) {
    const first = readVersion(db, word, 1, schema);
    return first ? first.before : null;
  }
  const v = readVersion(db, word, st.head_seq, schema);
  return v ? v.after : null;
}

function assertHead(st: HistoryState, expectedHeadSeq: number | undefined): void {
  if (expectedHeadSeq === undefined) throw new HistoryConflictError('缺少 expected_head_seq');
  if (expectedHeadSeq !== st.head_seq) throw new HistoryConflictError();
}

/**
 * 追加新版本（编辑 / 恢复统一入口）。
 * head 之后的重做分支先截断（Word 行为），再追加；返回新的 head_seq。
 */
export function appendVersion(
  db: Db,
  word: string,
  wordId: number,
  action: string,
  summary: string,
  before: MeaningEntry[],
  after: MeaningEntry[],
  expectedHeadSeq: number | undefined,
  schema = 'main'
): number {
  const w = normalizeWord(word);
  const st = getState(db, w, schema);
  assertHead(st, expectedHeadSeq);

  db.prepare(`DELETE FROM ${table(schema, 'dict_edit_history')} WHERE word = ? AND seq > ?`).run(w, st.head_seq);
  const newSeq = st.head_seq + 1;
  db.prepare(
    `INSERT INTO ${table(schema, 'dict_edit_history')} (word, word_id, seq, action, summary, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(w, wordId, newSeq, action, summary, JSON.stringify(before), JSON.stringify(after));
  db.prepare(
    `INSERT INTO ${table(schema, 'dict_edit_state')} (word, word_id, head_seq, updated_at)
     VALUES (?, ?, ?, datetime('now','localtime'))
     ON CONFLICT(word) DO UPDATE SET head_seq = excluded.head_seq, word_id = excluded.word_id, updated_at = excluded.updated_at`
  ).run(w, wordId, newSeq);

  cleanupHistory(db, schema);
  return newSeq;
}

/** 撤销一步：返回应写回词库的释义（= 当前版本的 before） */
export function undo(db: Db, word: string, expectedHeadSeq: number | undefined, schema = 'main'): { head_seq: number; entries: MeaningEntry[] } {
  const w = normalizeWord(word);
  const st = getState(db, w, schema);
  assertHead(st, expectedHeadSeq);
  if (st.head_seq === 0) throw new HistoryGoneError('没有可撤销的修改');

  const v = readVersion(db, w, st.head_seq, schema);
  if (!v) throw new HistoryGoneError('版本记录不存在');
  const newHead = st.head_seq - 1;
  db.prepare(`UPDATE ${table(schema, 'dict_edit_state')} SET head_seq = ?, updated_at = datetime('now','localtime') WHERE word = ?`).run(newHead, w);
  return { head_seq: newHead, entries: v.before };
}

/** 前进一步：返回应写回词库的释义（= 下一版本的 after） */
export function redo(db: Db, word: string, expectedHeadSeq: number | undefined, schema = 'main'): { head_seq: number; entries: MeaningEntry[] } {
  const w = normalizeWord(word);
  const st = getState(db, w, schema);
  assertHead(st, expectedHeadSeq);
  if (st.head_seq >= st.latest_seq) throw new HistoryGoneError('没有可重做的修改');

  const v = readVersion(db, w, st.head_seq + 1, schema);
  if (!v) throw new HistoryGoneError('版本记录不存在');
  const newHead = st.head_seq + 1;
  db.prepare(`UPDATE ${table(schema, 'dict_edit_state')} SET head_seq = ?, updated_at = datetime('now','localtime') WHERE word = ?`).run(newHead, w);
  return { head_seq: newHead, entries: v.after };
}

/**
 * 恢复到版本 seq（seq=0 为词库原始数据）。
 * 恢复本身生成新版本（action='restore'），因此可继续撤销；重做分支按 Word 行为截断。
 */
export function restoreTo(
  db: Db,
  word: string,
  seq: number,
  expectedHeadSeq: number | undefined,
  wordId: number,
  schema = 'main'
): { head_seq: number; entries: MeaningEntry[] } {
  const w = normalizeWord(word);
  const st = getState(db, w, schema);
  assertHead(st, expectedHeadSeq);
  if (seq === st.head_seq) throw new HistoryGoneError('该版本已是当前版本');
  if (seq < 0 || seq > st.latest_seq) throw new HistoryGoneError('目标版本不存在');

  // 目标快照：seq=0 取最早一行的 before（词库原始数据），否则取该版本的 after
  const target = seq === 0 ? readVersion(db, w, 1, schema)?.before : readVersion(db, w, seq, schema)?.after;
  if (!target) throw new HistoryGoneError('目标版本不存在');
  const current = currentEntries(db, w, schema) ?? [];

  const newHead = appendVersion(db, w, wordId, 'restore', `恢复到版本 ${seq}`, current, target, expectedHeadSeq, schema);
  return { head_seq: newHead, entries: target };
}

/** 版本列表（含 seq=0 原始词库数据） */
export function listHistory(db: Db, word: string, schema = 'main'): HistoryItem[] {
  const w = normalizeWord(word);
  const rows = db.prepare(
    `SELECT seq, action, summary, after_json, before_json, created_at FROM ${table(schema, 'dict_edit_history')} WHERE word = ? ORDER BY seq ASC`
  ).all(w) as any[];
  const st = getState(db, w, schema);
  const items: HistoryItem[] = [];
  if (rows.length) {
    items.push({
      seq: 0,
      action: 'original',
      summary: '原始词库数据',
      created_at: '',
      is_head: st.head_seq === 0,
      after: JSON.parse(rows[0].before_json) as MeaningEntry[],
    });
  }
  for (const r of rows) {
    items.push({
      seq: r.seq,
      action: r.action,
      summary: r.summary,
      created_at: r.created_at,
      is_head: r.seq === st.head_seq,
      after: JSON.parse(r.after_json) as MeaningEntry[],
    });
  }
  return items;
}

/**
 * 清理：超过保留期（14 天）的记录删除但每词保留最新一条；每词上限 200 条。
 * head_seq 收敛到现存 seq 范围内。
 */
export function cleanupHistory(db: Db, schema = 'main', retentionDays = RETENTION_DAYS, maxPerWord = MAX_VERSIONS_PER_WORD): void {
  db.prepare(
    `DELETE FROM ${table(schema, 'dict_edit_history')}
     WHERE created_at < datetime('now', ? , 'localtime')
       AND id NOT IN (SELECT MAX(id) FROM ${table(schema, 'dict_edit_history')} GROUP BY word)`
  ).run(`-${retentionDays} days`);

  const words = db.prepare(`SELECT word FROM ${table(schema, 'dict_edit_history')} GROUP BY word HAVING COUNT(*) > ?`).all(maxPerWord) as any[];
  for (const { word } of words) {
    db.prepare(
      `DELETE FROM ${table(schema, 'dict_edit_history')}
       WHERE word = ? AND seq NOT IN (SELECT seq FROM ${table(schema, 'dict_edit_history')} WHERE word = ? ORDER BY seq DESC LIMIT ?)`
    ).run(word, word, maxPerWord);
  }

  // head_seq 收敛：只能指向现存版本或 0
  db.prepare(
    `UPDATE ${table(schema, 'dict_edit_state')}
     SET head_seq = MIN(head_seq, COALESCE((SELECT MAX(seq) FROM ${table(schema, 'dict_edit_history')} h WHERE h.word = dict_edit_state.word), 0))`
  ).run();
}
