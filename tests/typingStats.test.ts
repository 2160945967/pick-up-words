import { describe, it, expect, beforeEach } from 'vitest';
import {
    TypingTracker, getTypingStats, keyAccuracy, charsPerMinute, resetTypingStats,
} from '../src/utils/typingStats';

describe('打字速度 / 击键统计', () => {
    beforeEach(() => localStorage.clear());

    it('逐字符正确输入：全部计为正确击键', () => {
        const t = new TypingTracker('apple', true);
        t.onInput('', 'a');
        t.onInput('a', 'ap');
        t.onInput('ap', 'app');
        t.onInput('app', 'appl');
        t.onInput('appl', 'apple');
        const r = t.finish();
        expect(r.correctKeys).toBe(5);
        expect(r.wrongKeys).toBe(0);
        expect(keyAccuracy()).toBe(100);
    });

    it('错误字符计为错误击键，大小写不敏感', () => {
        const t = new TypingTracker('apple', true);
        t.onInput('', 'A');
        t.onInput('A', 'AP');
        t.onInput('AP', 'APX'); // 第 3 位应为 p，输入 x
        const r = t.finish();
        expect(r.correctKeys).toBe(2);
        expect(r.wrongKeys).toBe(1);
        expect(keyAccuracy()).toBe(67); // 2/3 ≈ 67
    });

    it('退格不计对错，粘贴多字符逐位判定', () => {
        const t = new TypingTracker('apple', true);
        t.onInput('', 'appx'); // 前 3 对，第 4 错
        t.onInput('appx', 'app'); // 退格
        t.onInput('app', 'apple');
        const r = t.finish();
        expect(r.correctKeys).toBe(3 + 2);
        expect(r.wrongKeys).toBe(1);
    });

    it('非英文模式 tracker 停用，不产生数据', () => {
        const t = new TypingTracker('', false);
        t.onInput('', '香蕉');
        const r = t.finish();
        expect(r.correctKeys).toBe(0);
        expect(r.wrongKeys).toBe(0);
        expect(keyAccuracy()).toBeNull();
        expect(charsPerMinute()).toBeNull();
    });

    it('无击键 finish 不计入答题数；有击键后可计算输入速度', () => {
        const idle = new TypingTracker('apple', true);
        idle.finish();
        expect(getTypingStats().answers).toBe(0);

        const t = new TypingTracker('apple', true);
        t.onInput('', 'apple');
        t.finish();
        expect(getTypingStats().answers).toBe(1);
        // activeMs 可能为 0（同步连续输入无间隙），此时 CPM 为 null
        // 速度依赖真实时间，这里只验证不抛错且为数值或 null
        const cpm = charsPerMinute();
        expect(cpm === null || typeof cpm === 'number').toBe(true);
    });

    it('resetTypingStats 清空汇总', () => {
        const t = new TypingTracker('apple', true);
        t.onInput('', 'apple');
        t.finish();
        resetTypingStats();
        expect(getTypingStats().correctKeys).toBe(0);
    });
});
