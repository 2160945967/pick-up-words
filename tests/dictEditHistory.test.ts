import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  ensureHistoryTables, getState, appendVersion, undo, redo, restoreTo,
  listHistory, currentEntries, cleanupHistory, HistoryConflictError, HistoryGoneError,
} from '../electron/services/dictEdit/history';
import { MeaningEntry } from '../electron/services/dictEdit/meaningEdit';

const e = (pos: string, text: string): MeaningEntry => ({ pos, text });

describe('版本留痕状态机', () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureHistoryTables(db);
  });
  afterEach(() => db.close());

  const WORD = 'apple';

  it('初始状态 head=0 可撤销=false', () => {
    const st = getState(db, WORD);
    expect(st.head_seq).toBe(0);
    expect(st.can_undo).toBe(false);
    expect(st.can_redo).toBe(false);
  });

  it('appendVersion 追加版本并推进 head', () => {
    const before = [e('n.', '苹果')];
    const after = [e('n.', '苹果树')];
    const seq = appendVersion(db, WORD, 1, 'edit_entry', '编辑释义', before, after, 0);
    expect(seq).toBe(1);
    const st = getState(db, WORD);
    expect(st.head_seq).toBe(1);
    expect(st.can_undo).toBe(true);
    expect(currentEntries(db, WORD)).toEqual(after);
  });

  it('expected_head_seq 不符抛 HistoryConflictError', () => {
    appendVersion(db, WORD, 1, 'edit_entry', 'x', [e('n.', 'a')], [e('n.', 'b')], 0);
    expect(() => appendVersion(db, WORD, 1, 'edit_entry', 'x', [], [], 99)).toThrow(HistoryConflictError);
    expect(() => undo(db, WORD, 5)).toThrow(HistoryConflictError);
    expect(() => redo(db, WORD, 5)).toThrow(HistoryConflictError);
  });

  it('undo 回到 before，redo 回到 after', () => {
    const v1before = [e('n.', '苹果')];
    const v1after = [e('n.', '苹果树')];
    appendVersion(db, WORD, 1, 'edit_entry', '改1', v1before, v1after, 0);

    const u = undo(db, WORD, 1);
    expect(u.head_seq).toBe(0);
    expect(u.entries).toEqual(v1before);
    expect(getState(db, WORD).can_redo).toBe(true);

    const r = redo(db, WORD, 0);
    expect(r.head_seq).toBe(1);
    expect(r.entries).toEqual(v1after);
  });

  it('head=0 时 undo 抛 HistoryGoneError；head=latest 时 redo 抛', () => {
    expect(() => undo(db, WORD, 0)).toThrow(HistoryGoneError);
    appendVersion(db, WORD, 1, 'edit_entry', 'x', [], [], 0);
    expect(() => redo(db, WORD, 1)).toThrow(HistoryGoneError);
  });

  it('撤销后新编辑截断重做分支', () => {
    appendVersion(db, WORD, 1, 'edit_entry', '改1', [e('n.', 'a')], [e('n.', 'b')], 0);
    appendVersion(db, WORD, 1, 'edit_entry', '改2', [e('n.', 'b')], [e('n.', 'c')], 1);
    undo(db, WORD, 2); // head=1
    // 新编辑应从 seq=2 开始（旧 seq=2 的"改2"被截断）
    const seq = appendVersion(db, WORD, 1, 'edit_entry', '改2b', [e('n.', 'b')], [e('n.', 'd')], 1);
    expect(seq).toBe(2);
    expect(getState(db, WORD).latest_seq).toBe(2);
    expect(getState(db, WORD).can_redo).toBe(false);
    const items = listHistory(db, WORD);
    const summaries = items.map(i => i.summary);
    expect(summaries).not.toContain('改2');
    expect(summaries).toContain('改2b');
  });

  it('restore 生成新版本且可再撤销', () => {
    const original = [e('n.', '苹果')];
    appendVersion(db, WORD, 1, 'edit_entry', '改1', original, [e('n.', '苹果树')], 0);
    appendVersion(db, WORD, 1, 'edit_entry', '改2', [e('n.', '苹果树')], [e('n.', '果实')], 1);

    // 恢复到版本 1（=「苹果树」）
    const r = restoreTo(db, WORD, 1, 2, 1);
    expect(r.entries).toEqual([e('n.', '苹果树')]);
    expect(r.head_seq).toBe(3);
    expect(currentEntries(db, WORD)).toEqual([e('n.', '苹果树')]);

    // 恢复到原始（seq=0）也可
    const r0 = restoreTo(db, WORD, 0, 3, 1);
    expect(r0.entries).toEqual(original);
    // 恢复本身可撤销
    const u = undo(db, WORD, r0.head_seq);
    expect(u.entries).toEqual([e('n.', '苹果树')]);
  });

  it('restore 到当前版本抛 HistoryGoneError', () => {
    appendVersion(db, WORD, 1, 'edit_entry', 'x', [], [], 0);
    expect(() => restoreTo(db, WORD, 1, 1, 1)).toThrow(HistoryGoneError);
    expect(() => restoreTo(db, WORD, 99, 1, 1)).toThrow(HistoryGoneError);
  });

  it('listHistory 含原始版本 seq=0 且 is_head 正确', () => {
    appendVersion(db, WORD, 1, 'edit_entry', '改1', [e('n.', 'a')], [e('n.', 'b')], 0);
    appendVersion(db, WORD, 1, 'edit_entry', '改2', [e('n.', 'b')], [e('n.', 'c')], 1);
    const items = listHistory(db, WORD);
    expect(items.length).toBe(3);
    expect(items[0].seq).toBe(0);
    expect(items[0].is_head).toBe(false);
    expect(items[2].is_head).toBe(true);
    expect(items[2].summary).toBe('改2');
  });

  it('14 天清理保留每词最新一条', () => {
    appendVersion(db, WORD, 1, 'edit_entry', '旧1', [], [], 0);
    appendVersion(db, WORD, 1, 'edit_entry', '旧2', [], [], 1);
    // 伪造两条老记录（15 天前）+ 一条新的
    db.prepare(`UPDATE dict_edit_history SET created_at = datetime('now','-15 days','localtime') WHERE seq <= 2`).run();
    appendVersion(db, WORD, 1, 'edit_entry', '新', [], [], 2);
    cleanupHistory(db, 'main', 14);
    const items = listHistory(db, WORD);
    const summaries = items.map(i => i.summary);
    expect(summaries).not.toContain('旧1');
    // 旧2 是"每词最新"之外的旧记录应删，但删除时保的是 MAX(id)（即"新"）；旧2 也应删
    expect(summaries).not.toContain('旧2');
    expect(summaries).toContain('新');
  });

  it('每词上限 200 条：超限删最旧', () => {
    for (let i = 1; i <= 210; i++) {
      appendVersion(db, WORD, 1, 'edit_entry', `v${i}`, [], [], i - 1);
    }
    cleanupHistory(db, 'main', 14, 200);
    const st = getState(db, WORD);
    expect(st.latest_seq).toBe(210);
    const items = listHistory(db, WORD);
    // 200 条版本 + 1 条原始
    expect(items.length).toBe(201);
  });
});
