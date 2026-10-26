// 顽固词（leech）检测：一个词累计答错（lapse）达到阈值后标记为顽固词。
// 借鉴 Anki/FSRS 的 leech 概念：这类词反复记不住，需要换助记或单独强化。
// 数据直接挂在 learningHistory[word] 上：lapses（累计答错次数）、leech（是否顽固）。

import { safeParse } from './storage';

/** 累计答错达到此次数即判定为顽固词（Anki 默认 8） */
export const LEECH_THRESHOLD = 8;

export interface LeechUpdate {
    /** 本次调用是否刚把该词标记为顽固词（用于弹一次提示） */
    becameLeech: boolean;
    /** 该词当前累计答错次数 */
    lapses: number;
    isLeech: boolean;
}

/**
 * 在一次答题落库后更新顽固词状态（就地修改传入的 history 条目）。
 * @param entry learningHistory[word]
 * @param isCorrect 本次是否答对
 */
export function applyLeech(
    entry: Record<string, unknown>,
    isCorrect: boolean,
): LeechUpdate {
    let lapses = Number(entry.lapses) || 0;
    if (!isCorrect) lapses += 1;
    entry.lapses = lapses;

    const wasLeech = entry.leech === true;
    const isLeech = lapses >= LEECH_THRESHOLD;
    entry.leech = isLeech;

    return { becameLeech: isLeech && !wasLeech, lapses, isLeech };
}

export interface LeechItem {
    word: string;
    lapses: number;
    lastStudyTime: number;
}

/** 读取全部顽固词（按累计答错次数降序） */
export function getLeechWords(): LeechItem[] {
    const history = safeParse<Record<string, Record<string, unknown>>>('learningHistory', {});
    const out: LeechItem[] = [];
    Object.keys(history).forEach(word => {
        const e = history[word];
        if (e && e.leech === true) {
            out.push({
                word,
                lapses: Number(e.lapses) || 0,
                lastStudyTime: Number(e.lastStudyTime) || 0,
            });
        }
    });
    return out.sort((a, b) => b.lapses - a.lapses || b.lastStudyTime - a.lastStudyTime);
}

/** 顽固词总数（用于折叠面板计数） */
export function getLeechCount(): number {
    return getLeechWords().length;
}

/** 手动把某词移出顽固词清单（保留 lapses，仅清 leech 标记） */
export function clearLeech(word: string): void {
    const history = safeParse<Record<string, Record<string, unknown>>>('learningHistory', {});
    if (history[word]) {
        history[word].leech = false;
        localStorage.setItem('learningHistory', JSON.stringify(history));
    }
}
