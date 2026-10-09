// 判题日志服务（全本地、不联网）
// 记录每次判题的输入 / 字面命中 / 语义分数 / 结论，供评测集采样与阈值标定。
// 写入用户数据目录 logs/grading-log.jsonl，按日清理、仅保留最近 14 天。
// 所有操作失败静默，绝不影响正常答题。

import * as path from 'path';
import * as fs from 'fs';
import { USER_DATA_DIR, ensureDirExists } from '../utils/helpers';

const LOG_DIR = path.join(USER_DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'grading-log.jsonl');
const RETAIN_MS = 14 * 24 * 60 * 60 * 1000;

let prunedDay = '';

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function readTs(line: string): number | null {
  try {
    const o = JSON.parse(line);
    return typeof o.ts === 'number' ? o.ts : null;
  } catch {
    return null;
  }
}

export function getGradingLogPath(): string {
  return LOG_FILE;
}

/** 清理 14 天前的记录（每天首次写入时调用一次） */
export function pruneGradingLog(now: number = Date.now()): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const cutoff = now - RETAIN_MS;
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    const kept: string[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const ts = readTs(t);
      if (ts === null || ts >= cutoff) kept.push(t);
    }
    fs.writeFileSync(LOG_FILE, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
  } catch (e) {
    console.warn('[GradingLog] prune failed:', e);
  }
}

/** 追加一条判题记录 */
export function appendGradingLog(entry: Record<string, unknown>): void {
  try {
    ensureDirExists(LOG_DIR);
    const now = Date.now();
    const dk = dayKey(now);
    if (prunedDay !== dk) {
      pruneGradingLog(now);
      prunedDay = dk;
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.warn('[GradingLog] append failed:', e);
  }
}

/** 读取全部日志文本（导出用） */
export function readGradingLogs(): string {
  try {
    return fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
  } catch {
    return '';
  }
}
