import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupGlobalRegistry, initActionDelegation } from '../src/global-registry';

initActionDelegation(); // 幂等：整个文件只注册一次 document 捕获阶段监听

function click(el: Element): void {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

describe('data-action 事件委托', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('默认把 data-word 作为参数传给注册函数', () => {
        const fn = vi.fn();
        setupGlobalRegistry({ jumpToWord: fn });
        document.body.innerHTML = `<a data-action="jumpToWord" data-word="abandon">x</a>`;
        click(document.querySelector('a')!);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('abandon');
    });

    it('playPronunciation 收到 [pron, word]', () => {
        const fn = vi.fn();
        setupGlobalRegistry({ playPronunciation: fn });
        document.body.innerHTML = `<button data-action="playPronunciation" data-pron="uk" data-word="record">🔊</button>`;
        click(document.querySelector('button')!);
        expect(fn).toHaveBeenCalledWith('uk', 'record');
    });

    it('playSentencePronunciation 只收到 word', () => {
        const fn = vi.fn();
        setupGlobalRegistry({ playSentencePronunciation: fn });
        document.body.innerHTML = `<button data-action="playSentencePronunciation" data-word="how are you">🔊</button>`;
        click(document.querySelector('button')!);
        expect(fn).toHaveBeenCalledWith('how are you');
    });

    it('toggle 类点击内部元素时，把最近的 data-action 元素本身传回', () => {
        const fn = vi.fn();
        setupGlobalRegistry({ toggleHistoryDay: fn });
        document.body.innerHTML = `<div data-action="toggleHistoryDay"><span>header</span></div>`;
        click(document.querySelector('span')!);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn.mock.calls[0][0]).toBe(document.querySelector('div'));
    });

    it('data-stop 阻止点击继续冒泡到父容器', () => {
        const outer = vi.fn();
        const inner = vi.fn();
        setupGlobalRegistry({ removeDueWord: inner });
        document.body.innerHTML = `<div id="outer"><button data-action="removeDueWord" data-word="w" data-stop>移除</button></div>`;
        document.getElementById('outer')!.addEventListener('click', outer);
        click(document.querySelector('button')!);
        expect(inner).toHaveBeenCalledTimes(1);
        expect(outer).not.toHaveBeenCalled();
    });

    it('含特殊字符的 data-word 原样传递', () => {
        const fn = vi.fn();
        setupGlobalRegistry({ jumpToWord: fn });
        document.body.innerHTML = `<a data-action="jumpToWord" data-word="o'clock">x</a>`;
        click(document.querySelector('a')!);
        expect(fn).toHaveBeenCalledWith("o'clock");
    });

    it('未注册的 action 不抛错', () => {
        document.body.innerHTML = `<a data-action="doesNotExist" data-word="x">x</a>`;
        expect(() => click(document.querySelector('a')!)).not.toThrow();
    });
});
