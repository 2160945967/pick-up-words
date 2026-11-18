// 判题日志前端封装（全本地、不联网）：
// 构造判题记录、经后端写入 logs/grading-log.jsonl，供评测集采样与阈值标定。
// 开关关闭或写入失败时静默，绝不影响正常答题。

import { appState } from '../store';
import { apiPost } from './api';
import type { CheckAnswerResult } from './quizHelper';
import type { FsrsGrade } from './scheduler';
import { QuizMode } from '../types/enums';

export const GRADING_SCHEMA = 'grading-v1';
export const SEMANTIC_THRESHOLD = 0.58;

export interface BuildGradingArgs {
    mode: QuizMode;
    word: string;
    source: string;
    targetMeanings: string[];
    userInput: string;
    result: CheckAnswerResult;
    cloze: boolean;
    semanticEnabled: boolean;
    /** FSRS 模式下本次评分；固定艾宾浩斯或不适用为 null */
    gradedGrade?: FsrsGrade | null;
    now?: number;
    appVersion?: string;
}

export type Verdict = 'correct' | 'partial' | 'wrong';

export function verdictOf(result: CheckAnswerResult): Verdict {
    if (result.isCorrect) return 'correct';
    if (result.isPartial) return 'partial';
    return 'wrong';
}

// 纯函数：组装一条判题记录。语义明细来自注入化的 checkQuizAnswer，
// gradedGrade 来自集中的 decideFsrsGrade。
export function buildGradingEntry(a: BuildGradingArgs): Record<string, unknown> {
    const now = a.now ?? Date.now();
    const isZh = a.mode === QuizMode.EnToZh;
    return {
        schema: GRADING_SCHEMA,
        ts: now,
        appVersion: a.appVersion ?? '2.1.0',
        mode: a.mode,
        word: a.word,
        source: a.source,
        targetMeanings: a.targetMeanings,
        userInput: a.userInput,
        literalHits: isZh ? (a.result.zhCorrect ?? []) : [],
        semantic: (() => {
            const s = a.result.semantic;
            return {
                used: s ? s.used : a.semanticEnabled,
                available: s ? s.available : false,
                scores: s
                    ? s.calls.map(c => ({ input: c.input, target: c.target, score: c.score, match: c.match, latencyMs: c.latencyMs }))
                    : [],
                threshold: SEMANTIC_THRESHOLD,
                latencyMs: s && s.calls.length ? s.calls.reduce((n, c) => n + (c.latencyMs || 0), 0) : null,
            };
        })(),
        verdict: verdictOf(a.result),
        gradedGrade: a.gradedGrade ?? null,
        cloze: a.cloze,
    };
}

// 写入一条判题日志（开关关闭 / 失败静默）
export async function logGrading(entry: Record<string, unknown>): Promise<void> {
    try {
        if (appState.settings.gradingLogEnabled === false) return;
        await apiPost('/api/grading-log', { entry });
    } catch {
        /* 静默 */
    }
}

// 导出判题日志（浏览器下载 JSONL）
export function exportGradingLog(): void {
    const a = document.createElement('a');
    a.href = '/api/grading-log/export';
    a.download = 'grading-log.jsonl';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
}
