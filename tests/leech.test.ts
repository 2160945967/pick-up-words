import { describe, it, expect, beforeEach } from 'vitest';
import {
    applyLeech, getLeechWords, getLeechCount, clearLeech, LEECH_THRESHOLD,
} from '../src/utils/leech';

describe('顽固词检测', () => {
    beforeEach(() => localStorage.clear());

    it('答对不增加 lapses', () => {
        const e: Record<string, unknown> = {};
        const r = applyLeech(e, true);
        expect(r.lapses).toBe(0);
        expect(r.isLeech).toBe(false);
        expect(r.becameLeech).toBe(false);
    });

    it('答错累计 lapses，未达阈值不标记', () => {
        const e: Record<string, unknown> = {};
        for (let i = 0; i < LEECH_THRESHOLD - 1; i++) {
            const r = applyLeech(e, false);
            expect(r.isLeech).toBe(false);
        }
        expect(e.lapses).toBe(LEECH_THRESHOLD - 1);
    });

    it('答错达到阈值标记为顽固词，becameLeech 仅首次为 true', () => {
        const e: Record<string, unknown> = {};
        let became = 0;
        for (let i = 0; i < LEECH_THRESHOLD; i++) {
            if (applyLeech(e, false).becameLeech) became++;
        }
        expect(e.leech).toBe(true);
        expect(became).toBe(1);
        // 再答错一次，已是顽固词，becameLeech 不再触发
        expect(applyLeech(e, false).becameLeech).toBe(false);
    });

    it('getLeechWords 读取并按 lapses 降序，clearLeech 清除标记', () => {
        const history: Record<string, Record<string, unknown>> = {
            apple: { lapses: 9, leech: true, lastStudyTime: 100 },
            banana: { lapses: 8, leech: true, lastStudyTime: 200 },
            cat: { lapses: 3, leech: false },
        };
        localStorage.setItem('learningHistory', JSON.stringify(history));
        expect(getLeechCount()).toBe(2);
        const words = getLeechWords();
        expect(words[0].word).toBe('apple');
        expect(words[1].word).toBe('banana');

        clearLeech('apple');
        expect(getLeechCount()).toBe(1);
        // 清除标记但保留 lapses
        const after = JSON.parse(localStorage.getItem('learningHistory') || '{}');
        expect(after.apple.leech).toBe(false);
        expect(after.apple.lapses).toBe(9);
    });
});
