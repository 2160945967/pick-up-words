import { describe, it, expect, vi, beforeEach } from 'vitest';

// 隔离重依赖：只提供模块用到的 escapeHtml 与 appState
vi.mock('../src/global', () => ({
    escapeHtml: (s: string) =>
        s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    appState: { settings: { pronunciationType: 'us' } },
}));
const playSpy = vi.fn(() => Promise.resolve());
vi.mock('../src/utils/audio', () => ({
    playSentencePronunciation: (...args: unknown[]) => playSpy(...args),
}));

import { initArticleType } from '../src/modules/articleType';

const reading = {
    level: 'cet4',
    label: 'CET-4 阅读理解',
    count: 1,
    articles: [{ n: 1, t: 'Test Article', p: ['Hello world. Second sentence here.'] }],
};

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = (el: Element | null) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const byAction = (action: string) =>
    document.querySelector(`[data-action="${action}"]`) as HTMLElement | null;

describe('文章练习模块流程', () => {
    beforeEach(() => {
        vi.useRealTimers();
        playSpy.mockClear();
        window.scrollTo = vi.fn();
        global.fetch = vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve(reading),
            } as Response));
        document.body.innerHTML = '<div id="article-type-page" class="content-page"></div>';
        initArticleType();
    });

    it('首页渲染两个难度入口与模式说明', () => {
        const box = document.getElementById('article-type-page');
        expect(box?.textContent).toContain('文章练习');
        expect(box?.querySelectorAll('[data-action="at-list"]').length).toBe(2);
        expect(box?.textContent).toContain('跟打模式');
        expect(box?.textContent).toContain('听写模式');
    });

    it('跟打：逐字符红绿反馈，敲完自动进下一句', async () => {
        // 进入四级列表
        click(document.querySelector('[data-action="at-list"][data-level="cet4"]'));
        await flush();
        await flush();
        expect(document.getElementById('article-type-page')?.textContent).toContain('Test Article');

        // 打开文章（默认跟打）
        click(byAction('at-open'));
        await flush();
        expect(document.querySelector('.at-mode-tag')?.textContent).toContain('跟打');

        const input = document.getElementById('at-input') as HTMLInputElement;
        // 输入部分正确文本
        input.value = 'Hello';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.querySelectorAll('.tc-ok').length).toBe(5);
        expect(document.querySelectorAll('.tc-ghost').length).toBeGreaterThan(0);

        // 输入一个错字
        input.value = 'Hello worlx';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.querySelectorAll('.tc-bad').length).toBeGreaterThan(0);

        // 输入完整正确句子，等待自动进句
        input.value = 'Hello world.';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 320));

        expect(document.querySelector('.ex-topbar-meta')?.textContent).toContain('2/2');
        const input2 = document.getElementById('at-input') as HTMLInputElement;
        expect(input2.value).toBe('');
    });

    it('跟打：按词分组，单词不被拆行，空格为可断点', async () => {
        click(document.querySelector('[data-action="at-list"][data-level="cet4"]'));
        await flush();
        await flush();
        click(byAction('at-open'));
        await flush();

        const display = document.getElementById('at-display') as HTMLElement;
        // 首句 "Hello world."：两个词、一个空格
        const words = display.querySelectorAll('.at-word');
        expect(words.length).toBe(2);
        expect(display.querySelectorAll('.at-space').length).toBe(1);
        // 词容器内不含空格片段，整词字符包在一起
        expect(words[0].textContent).toBe('Hello');
        expect(words[0].querySelectorAll('.tc:not(.tc-caret)').length).toBe(5);
        expect(words[1].textContent).toBe('world.');
        expect(display.querySelectorAll('.at-word .at-space').length).toBe(0);

        // 输入部分内容后仍按词分组（已输入词与 ghost 词各自成组）
        const input = document.getElementById('at-input') as HTMLInputElement;
        input.value = 'Hello wor';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(document.getElementById('at-display')?.querySelectorAll('.at-word').length).toBe(2);
        expect(document.querySelector('.at-word')?.textContent).toBe('Hello');
    });

    it('听写：隐藏文本、自动放音、可重播、可查看答案', async () => {
        click(document.querySelector('[data-action="at-list"][data-level="cet4"]'));
        await flush();
        await flush();
        // 切到听写（精确定位听写按钮）
        click(document.querySelector('[data-action="at-mode"][data-mode="dictation"]'));
        await flush();
        // 打开文章
        click(byAction('at-open'));
        await flush();

        // 进入即自动播放
        expect(playSpy).toHaveBeenCalled();
        expect(playSpy.mock.calls[0][0]).toBe('us');
        // 初始隐藏目标，只有提示与光标，无 ghost 铺底
        expect(document.querySelector('.at-dict-hint')?.textContent).toContain('凭记忆');
        expect(document.querySelectorAll('.tc-ghost').length).toBe(0);

        // 重播
        const callsBefore = playSpy.mock.calls.length;
        click(byAction('at-play'));
        expect(playSpy.mock.calls.length).toBe(callsBefore + 1);

        // 查看答案：填入原文并对照
        click(byAction('at-reveal'));
        const input = document.getElementById('at-input') as HTMLInputElement;
        expect(input.value).toBe('Hello world.');
        expect(document.querySelectorAll('.tc-ok').length).toBeGreaterThan(0);
    });
});
