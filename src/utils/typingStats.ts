// 打字速度 / 击键正确率统计（借鉴 Qwerty Learner 的量化指标）。
// 仅在英文输入模式（中译英 / 听写 / 跟练 / 听力卡壳）逐键统计：
//   - 新增字符与目标单词对应位置一致 → 正确击键，否则错误击键（退格不计）
//   - 主动输入时长：相邻击键间隙封顶 2 秒，排除长时间停顿/阅读
// 汇总存 localStorage（all-time），结果页展示平均输入速度与击键正确率。

import { safeParse } from './storage';

const STATS_KEY = 'typingStats';
const GAP_CAP_MS = 2000; // 相邻击键间隙超过 2 秒不计入主动输入时长

export interface TypingStats {
    correctKeys: number;
    wrongKeys: number;
    activeMs: number;
    answers: number;
}

function emptyStats(): TypingStats {
    return { correctKeys: 0, wrongKeys: 0, activeMs: 0, answers: 0 };
}

export function getTypingStats(): TypingStats {
    const s = safeParse<TypingStats>(STATS_KEY, emptyStats());
    return {
        correctKeys: Number(s.correctKeys) || 0,
        wrongKeys: Number(s.wrongKeys) || 0,
        activeMs: Number(s.activeMs) || 0,
        answers: Number(s.answers) || 0,
    };
}

export function resetTypingStats(): void {
    localStorage.setItem(STATS_KEY, JSON.stringify(emptyStats()));
}

/** 单题逐键追踪器 */
export class TypingTracker {
    private target: string;
    private enabled: boolean;
    private correctKeys = 0;
    private wrongKeys = 0;
    private activeMs = 0;
    private lastKeyAt: number | null = null;

    /** @param target 目标正确拼写（英文）；非英文模式传空，tracker 自动停用 */
    constructor(target: string, isEnglish: boolean) {
        this.target = (target || '').toLowerCase();
        this.enabled = isEnglish && this.target.length > 0;
    }

    /** 每次输入后调用，传入变更前/变更后的值 */
    onInput(oldVal: string, newVal: string): void {
        if (!this.enabled) return;
        if (newVal.length > oldVal.length) {
            // 新增了字符（可能一次粘贴多个，逐位判定）
            const now = Date.now();
            if (this.lastKeyAt !== null) {
                this.activeMs += Math.min(now - this.lastKeyAt, GAP_CAP_MS);
            }
            this.lastKeyAt = now;
            for (let i = oldVal.length; i < newVal.length; i++) {
                const typed = newVal[i]?.toLowerCase();
                if (typed === this.target[i]) this.correctKeys++;
                else this.wrongKeys++;
            }
        } else if (newVal.length < oldVal.length) {
            // 退格：记录一次时间但不计对错
            this.lastKeyAt = Date.now();
        }
    }

    /** 提交时结束本题，合并入汇总并返回本题数据 */
    finish(): { correctKeys: number; wrongKeys: number; activeMs: number } {
        if (!this.enabled) return { correctKeys: 0, wrongKeys: 0, activeMs: 0 };
        const stats = getTypingStats();
        stats.correctKeys += this.correctKeys;
        stats.wrongKeys += this.wrongKeys;
        stats.activeMs += this.activeMs;
        // 仅当确实有击键时才计入答题数（手动看答案、未输入不计）
        if (this.correctKeys + this.wrongKeys > 0) stats.answers += 1;
        localStorage.setItem(STATS_KEY, JSON.stringify(stats));
        return { correctKeys: this.correctKeys, wrongKeys: this.wrongKeys, activeMs: this.activeMs };
    }
}

/** 击键正确率（0~100），无击键返回 null */
export function keyAccuracy(s: TypingStats = getTypingStats()): number | null {
    const total = s.correctKeys + s.wrongKeys;
    if (total === 0) return null;
    return Math.round((s.correctKeys / total) * 100);
}

/** 平均输入速度（字符/分钟，含正确与错误击键），无数据返回 null */
export function charsPerMinute(s: TypingStats = getTypingStats()): number | null {
    const total = s.correctKeys + s.wrongKeys;
    if (s.activeMs <= 0 || total === 0) return null;
    return Math.round(total / (s.activeMs / 60000));
}
