import { describe, it, expect } from 'vitest';
import {
    computeFsrs, curveRetention, getCardRetrievability, decideFsrsGrade,
    normalizeRetention,
} from '../src/utils/scheduler';

const DAY = 86_400_000;

describe('ts-fsrs 调度 computeFsrs', () => {
    it('新词 Again 进入短时学习步骤（约 1 分钟后到期）', () => {
        const now = Date.now();
        const r = computeFsrs(undefined, 'again', now);
        expect(r.nextReviewTime).toBeGreaterThan(now - 1000);
        expect(r.nextReviewTime - now).toBeLessThan(11 * 60 * 1000);
    });

    it('新词 Good 先走学习步骤，再次 Good 毕业后约 1~5 天到期', () => {
        const now = Date.now();
        const r1 = computeFsrs(undefined, 'good', now);
        expect((r1.nextReviewTime - now) / DAY).toBeLessThan(1); // 约 10 分钟学习步骤
        const r2 = computeFsrs(r1.card, 'good', r1.nextReviewTime);
        const days = (r2.nextReviewTime - r1.nextReviewTime) / DAY;
        expect(days).toBeGreaterThanOrEqual(0.9);
        expect(days).toBeLessThanOrEqual(5);
    });

    it('到期连续 Good，复习间隔逐步拉长', () => {
        let card: Record<string, unknown> | undefined;
        let t = Date.now();
        const scheduled: number[] = [];
        for (let i = 0; i < 5; i++) {
            const r = computeFsrs(card, 'good', t);
            card = r.card;
            scheduled.push(r.scheduledDays);
            t = r.nextReviewTime;
        }
        expect(scheduled[4]).toBeGreaterThan(scheduled[0]);
    });

    it('无卡时可提取度为 null', () => {
        expect(getCardRetrievability(undefined)).toBeNull();
    });
});

describe('遗忘曲线 curveRetention', () => {
    it('第 0 天回忆概率为 1', () => {
        expect(curveRetention(0, 3)).toBeCloseTo(1, 5);
    });
    it('随时间单调下降，90 天明显低于 30 天', () => {
        expect(curveRetention(90, 3)).toBeLessThan(curveRetention(30, 3));
        expect(curveRetention(90, 3)).toBeLessThan(0.7);
    });
    it('相同时间下稳定度越高，留存越高', () => {
        expect(curveRetention(30, 8)).toBeGreaterThan(curveRetention(30, 3));
    });
});

describe('decideFsrsGrade 评分映射', () => {
    it('答错 → again', () => {
        expect(decideFsrsGrade({ isCorrect: false, errorCountThisRound: 0 })).toBe('again');
    });
    it('本轮错过后才答对 → hard', () => {
        expect(decideFsrsGrade({ isCorrect: true, errorCountThisRound: 1 })).toBe('hard');
    });
    it('一次答对且 reps>=3 → easy', () => {
        expect(decideFsrsGrade({ isCorrect: true, errorCountThisRound: 0, oldReps: 3 })).toBe('easy');
    });
    it('一次答对但 reps<3 → good', () => {
        expect(decideFsrsGrade({ isCorrect: true, errorCountThisRound: 0, oldReps: 1 })).toBe('good');
    });
    it('无卡一次答对 → good', () => {
        expect(decideFsrsGrade({ isCorrect: true, errorCountThisRound: 0 })).toBe('good');
    });
});

describe('FSRS 可调参数（保留率 / fuzz）', () => {
    /** 连续 Good 培育一张成熟卡（进入 Review、间隔数天） */
    function buildMatureCard(rounds = 8): { card: Record<string, unknown>; t: number } {
        let card: Record<string, unknown> | undefined;
        let t = Date.now();
        for (let i = 0; i < rounds; i++) {
            const r = computeFsrs(card, 'good', t, { fuzzing: false });
            card = r.card;
            t = r.nextReviewTime;
        }
        return { card: card as Record<string, unknown>, t };
    }

    it('normalizeRetention 越界/非法值回退 0.9，合法值保留', () => {
        expect(normalizeRetention(0.5)).toBe(0.9);
        expect(normalizeRetention(1.2)).toBe(0.9);
        expect(normalizeRetention('x')).toBe(0.9);
        expect(normalizeRetention(undefined)).toBe(0.9);
        expect(normalizeRetention(0.95)).toBe(0.95);
    });

    it('期望保留率越高，毕业间隔越短（复习更频繁）', () => {
        const now = Date.now();
        const gradInterval = (ret: number): number => {
            const r1 = computeFsrs(undefined, 'good', now, { requestRetention: ret, fuzzing: false });
            const r2 = computeFsrs(r1.card, 'good', r1.nextReviewTime, { requestRetention: ret, fuzzing: false });
            return r2.nextReviewTime - r1.nextReviewTime;
        };
        expect(gradInterval(0.97)).toBeLessThan(gradInterval(0.8));
    });

    it('关闭 fuzz 间隔确定；开启 fuzz 后不同复习时刻得到散开的间隔', () => {
        const { card, t } = buildMatureCard();
        const off = new Set<number>();
        const on = new Set<number>();
        for (let i = 0; i < 50; i++) {
            const reviewAt = t + i * 1000; // 不同复习时刻 → 不同 fuzz 种子
            off.add(computeFsrs(card, 'good', reviewAt, { fuzzing: false }).scheduledDays);
            on.add(computeFsrs(card, 'good', reviewAt, { fuzzing: true }).scheduledDays);
        }
        expect(off.size).toBe(1);
        expect(on.size).toBeGreaterThan(1);
    });
});
