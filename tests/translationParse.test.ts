import { describe, it, expect } from 'vitest';
import {
  fallbackPart, normalizeNewlines, formatDefinitionHtml, parseMeanings,
} from '../src/utils/translation';

describe('fallbackPart', () => {
  it('唯一词性返回该词性', () => {
    expect(fallbackPart('adj')).toBe('adj.');
  });
  it('多词性且为单词返回空', () => {
    expect(fallbackPart('v n adj', 'apple')).toBe('');
  });
  it('无词性的短语标为词组', () => {
    expect(fallbackPart(undefined, 'good morning')).toBe('词组');
  });
  it('无词性的单词返回空', () => {
    expect(fallbackPart(undefined, 'apple')).toBe('');
  });
  it('中文类型标签原样透传（用户词典）', () => {
    expect(fallbackPart('句子', "it's still early days")).toBe('句子');
    expect(fallbackPart('词组', 'good morning')).toBe('词组');
    expect(fallbackPart('短语', 'by the way')).toBe('短语');
    expect(fallbackPart('n.', 'customword')).toBe('n.');
  });
});

describe('normalizeNewlines', () => {
  it('统一 CRLFR 为 LF', () => {
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc');
  });
  it('字面转义序列转为换行', () => {
    expect(normalizeNewlines('a\\nb')).toBe('a\nb');
  });
  it('空值返回空串', () => {
    expect(normalizeNewlines()).toBe('');
  });
});

describe('formatDefinitionHtml', () => {
  it('转义特殊字符', () => {
    expect(formatDefinitionHtml('a&b<c>')).toBe('a&amp;b&lt;c&gt;');
  });
  it('换行渲染为 br', () => {
    expect(formatDefinitionHtml('a\nb')).toBe('a<br>b');
  });
});

describe('parseMeanings', () => {
  it('解析带词性的释义', () => {
    expect(parseMeanings('n. 苹果')).toEqual([{ part: 'n.', definition: '苹果' }]);
  });
  it('无词性时用 pos 兜底', () => {
    const r = parseMeanings('苹果', undefined, { pos: 'n', word: 'apple' });
    expect(r[0]).toEqual({ part: 'n.', definition: '苹果' });
  });
  it('空翻译返回空数组', () => {
    expect(parseMeanings('')).toEqual([]);
    expect(parseMeanings(undefined)).toEqual([]);
  });
  it('同一词性重复释义去重', () => {
    const r = parseMeanings('n. 苹果；苹果');
    expect(r[0].definition).toBe('苹果');
  });
  it('用户词典句子词条用中文类型标签兜底', () => {
    const r = parseMeanings('尚在初期', '', { pos: '句子', word: "it's still early days" });
    expect(r).toEqual([{ part: '句子', definition: '尚在初期' }]);
  });
});
