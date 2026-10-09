import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveSessionState, loadSessionState, clearSessionState, createSession, markAnswered, sessionReducer,
  type QuizWordData,
} from '../src/utils/quizSession';

const words: QuizWordData[] = [
  { word: 'apple', meanings: [{ part: 'n.', definition: '苹果' }] },
  { word: 'banana', meanings: [{ part: 'n.', definition: '香蕉' }] },
];

describe('quizSession 存取', () => {
  beforeEach(() => localStorage.clear());

  it('保存后可加载，words 压缩为字符串再还原', () => {
    const s = createSession('quiz', 'favorites', words);
    saveSessionState(s);
    const loaded = loadSessionState();
    expect(loaded).not.toBeNull();
    expect(loaded!.words.map(w => w.word)).toEqual(['apple', 'banana']);
    expect(loaded!.source).toBe('favorites');
    expect(loaded!.type).toBe('quiz');
  });
  it('无状态时返回 null', () => {
    expect(loadSessionState()).toBeNull();
  });
  it('损坏的 JSON 返回 null', () => {
    localStorage.setItem('lastSessionState', '{bad json');
    expect(loadSessionState()).toBeNull();
  });
  it('clear 后为空', () => {
    const s = createSession('quiz', 'favorites', words);
    saveSessionState(s);
    clearSessionState();
    expect(loadSessionState()).toBeNull();
  });
});

describe('markAnswered 计数与推进', () => {
  beforeEach(() => localStorage.clear());

  it('答对计数 correct 并推进索引', () => {
    const s = createSession('quiz', 'favorites', words);
    markAnswered(s, 'apple', true);
    expect(s.correctCount).toBe(1);
    expect(s.wrongCount).toBe(0);
    expect(s.currentIndex).toBe(1);
    expect(s.answeredInThisRound).toContain('apple');
  });
  it('答错计数 wrong', () => {
    const s = createSession('quiz', 'favorites', words);
    markAnswered(s, 'apple', false);
    expect(s.wrongCount).toBe(1);
    expect(s.correctCount).toBe(0);
  });
});

describe('sessionReducer 纯 reducer', () => {
  beforeEach(() => localStorage.clear());

  it('answer 正确：计数并推进，且不修改原 state', () => {
    const s = createSession('quiz', 'favorites', words);
    const next = sessionReducer(s, { type: 'answer', word: 'apple', isCorrect: true });
    expect(next.correctCount).toBe(1);
    expect(next.wrongCount).toBe(0);
    expect(next.currentIndex).toBe(1);
    expect(next.answeredInThisRound).toContain('apple');
    expect(s.correctCount).toBe(0); // 原 state 保持不变
  });

  it('answer 错误计 wrong', () => {
    const s = createSession('quiz', 'favorites', words);
    const next = sessionReducer(s, { type: 'answer', word: 'apple', isCorrect: false });
    expect(next.wrongCount).toBe(1);
    expect(next.correctCount).toBe(0);
  });
});
