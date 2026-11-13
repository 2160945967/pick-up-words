import { describe, it, expect } from 'vitest';
import {
    stripCjkParentheses, splitSentences, buildArticleSentences,
} from '../src/utils/articleSentences';

describe('文章句子切分', () => {
    describe('stripCjkParentheses', () => {
        it('删除全角括号中文注释', () => {
            expect(stripCjkParentheses('amphipods（端足类动物） live in water'))
                .toBe('amphipods live in water');
        });

        it('删除半角括号内的中文', () => {
            expect(stripCjkParentheses('a test (测试) here')).toBe('a test here');
        });

        it('保留英文括号内容', () => {
            expect(stripCjkParentheses('see (i.e. the note) below')).toBe('see (i.e. the note) below');
        });

        it('处理多个相邻注释', () => {
            expect(stripCjkParentheses('cat（猫） dog（狗）')).toBe('cat dog');
        });

        it('删除括号外的内嵌中文并补空格', () => {
            expect(stripCjkParentheses('become高风险 when')).toBe('become when');
        });

        it('全角括号内为英文时去括号保留英文', () => {
            expect(stripCjkParentheses('cells（stem cells）to grow')).toBe('cells stem cells to grow');
        });

        it('空字符串安全', () => {
            expect(stripCjkParentheses('')).toBe('');
        });
    });

    describe('splitSentences', () => {
        it('基本按句切分并保留句末标点', () => {
            const s = splitSentences('Hello world. How are you? I am fine!');
            expect(s).toEqual(['Hello world.', 'How are you?', 'I am fine!']);
        });

        it('缩写不被误切', () => {
            const s = splitSentences('Mr. Smith is here. Dr. Lee arrived.');
            expect(s).toEqual(['Mr. Smith is here.', 'Dr. Lee arrived.']);
        });

        it('e.g. 与 i.e. 不被误切', () => {
            const s = splitSentences('Fruits, e.g. apples, are good. That is it.');
            expect(s[0]).toBe('Fruits, e.g. apples, are good.');
            expect(s.length).toBe(2);
        });

        it('U.S. 内部多点不被误切', () => {
            const s = splitSentences('He moved to the U.S. last year. Done.');
            expect(s[0]).toBe('He moved to the U.S. last year.');
            expect(s.length).toBe(2);
        });

        it('小数不被误切', () => {
            const s = splitSentences('The value is 3.14 today. Done.');
            expect(s[0]).toBe('The value is 3.14 today.');
        });

        it('无句末标点的尾部片段也保留', () => {
            const s = splitSentences('First sentence. A trailing fragment');
            expect(s).toEqual(['First sentence.', 'A trailing fragment']);
        });

        it('折叠多余空白', () => {
            const s = splitSentences('Too   many    spaces.   Next.');
            expect(s[0]).toBe('Too many spaces.');
        });

        it('空文本返回空数组', () => {
            expect(splitSentences('   ')).toEqual([]);
        });
    });

    describe('buildArticleSentences', () => {
        it('多段落清洗并切分', () => {
            const s = buildArticleSentences([
                'This is one.（注释） It has two.',
                'Another paragraph! Really?',
            ]);
            expect(s).toEqual(['This is one.', 'It has two.', 'Another paragraph!', 'Really?']);
        });

        it('剥注释后相邻单词不粘连', () => {
            const s = buildArticleSentences(['small crustaceans（端足类）that survive here.']);
            expect(s[0]).toBe('small crustaceans that survive here.');
        });

        it('整篇中文文章返回空数组', () => {
            const s = buildArticleSentences([
                '第六代移动通信技术正在发展，太赫兹频段应用广泛。',
                '然而仍面临技术挑战，研究人员开发新型天线。',
            ]);
            expect(s).toEqual([]);
        });

        it('非数组输入返回空', () => {
            expect(buildArticleSentences(null as unknown as string[])).toEqual([]);
        });
    });
});
