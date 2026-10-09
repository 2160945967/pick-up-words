import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkQuizAnswer, zhMeaningMatch, splitEcdictTranslation, updateMeaningWeight, updateMeaningWeights } from '../src/utils/quizHelper';
import { QuizMode } from '../src/types/enums';
import { apiPost } from '../src/utils/api';
import { appState } from '../src/store';

vi.mock('../src/utils/api', () => ({ apiPost: vi.fn() }));
const mockedApiPost = vi.mocked(apiPost);
const M = QuizMode;

beforeEach(() => {
  appState.settings.semanticSimilarityEnabled = true;
  mockedApiPost.mockReset();
});

describe('中译英 / 跟练 / 听写 判题', () => {
  it('完全一致判正确', async () => {
    const r = await checkQuizAnswer('apple', 'apple', [], M.ZhToEn, false);
    expect(r.isCorrect).toBe(true);
  });
  it('忽略大小写与首尾多余空格', async () => {
    const r = await checkQuizAnswer('  Apple ', 'apple', [], M.ZhToEn, false);
    expect(r.isCorrect).toBe(true);
  });
  it('拼写错误判错误', async () => {
    const r = await checkQuizAnswer('appla', 'apple', [], M.ZhToEn, false);
    expect(r.isCorrect).toBe(false);
  });
  it('接受可接受拼写（英美变体）', async () => {
    const r = await checkQuizAnswer('colour', 'color', [], M.ZhToEn, false, ['color', 'colour']);
    expect(r.isCorrect).toBe(true);
  });
  it('句子模式忽略标点差异', async () => {
    const r = await checkQuizAnswer('i like apples', 'I like apples.', [], M.ZhToEn, true);
    expect(r.isCorrect).toBe(true);
  });
});

describe('英译中判题', () => {
  const meanings = [{ part: 'adv.', definition: '大概，或许；很可能' }];

  it('命中词书释义判正确', async () => {
    const r = await checkQuizAnswer('大概', 'probably', meanings, M.EnToZh, false);
    expect(r.isCorrect).toBe(true);
  });
  it('命中 ECDict 附加释义（或许）判正确，不调用模型', async () => {
    const r = await checkQuizAnswer(
      '或许', 'probably', [{ part: 'adv.', definition: '很可能' }], M.EnToZh, false, undefined, ['大概', '或许'],
    );
    expect(r.isCorrect).toBe(true);
    expect(mockedApiPost).not.toHaveBeenCalled();
  });
  it('多个释义片段：正确绿色、错误红色，整体部分正确', async () => {
    mockedApiPost.mockRejectedValue(new Error('model unavailable'));
    const r = await checkQuizAnswer('大概，香蕉', 'probably', meanings, M.EnToZh, false);
    expect(r.isCorrect).toBe(false);
    expect(r.isPartial).toBe(true);
    expect(r.zhCorrect).toEqual(['大概']);
    expect(r.zhWrong).toEqual(['香蕉']);
  });
  it('全部错误', async () => {
    mockedApiPost.mockRejectedValue(new Error('model unavailable'));
    const r = await checkQuizAnswer('香蕉', 'probably', meanings, M.EnToZh, false);
    expect(r.isCorrect).toBe(false);
    expect(r.zhCorrect).toEqual([]);
    expect(r.zhWrong).toEqual(['香蕉']);
  });
  it('空答案判错误', async () => {
    const r = await checkQuizAnswer('   ', 'probably', meanings, M.EnToZh, false);
    expect(r.isCorrect).toBe(false);
  });
  it('语义模型判定近义说法正确', async () => {
    mockedApiPost.mockResolvedValue({ success: true, data: { isSimilar: true } } as any);
    const r = await checkQuizAnswer('也许', 'probably', [{ part: 'adv.', definition: '或许' }], M.EnToZh, false);
    expect(r.isCorrect).toBe(true);
    expect(r.zhCorrect).toEqual(['也许']);
  });
});

describe('zhMeaningMatch 字面匹配', () => {
  it('完全相等', () => expect(zhMeaningMatch('大概', '大概')).toBe(true));
  it('正确释义包含用户答案且占比足够', () => expect(zhMeaningMatch('大概', '大概情况')).toBe(true));
  it('占比不足不匹配', () => expect(zhMeaningMatch('大概', '大概的情况说明')).toBe(false));
  it('非中文且不一致不匹配', () => expect(zhMeaningMatch('abc', 'abd')).toBe(false));
  it('单字不匹配', () => expect(zhMeaningMatch('大', '大概')).toBe(false));
  it('无关词不匹配', () => expect(zhMeaningMatch('香蕉', '大概')).toBe(false));
});

describe('splitEcdictTranslation', () => {
  it('去除词性并按标点拆分', () => {
    const r = splitEcdictTranslation('adv. 大概, 或许；很可能');
    expect(r).toEqual(expect.arrayContaining(['大概', '或许', '很可能']));
  });
  it('空输入返回空数组', () => {
    expect(splitEcdictTranslation('')).toEqual([]);
    expect(splitEcdictTranslation(null)).toEqual([]);
  });
});

describe('checkQuizAnswer 依赖注入', () => {
  const meanings = [{ part: 'adv.', definition: '或许' }];

  it('使用注入的 scorer，并在结果中返回语义明细', async () => {
    const scorer = vi.fn().mockResolvedValue({ match: true, score: 0.72, latencyMs: 5, available: true });
    const r = await checkQuizAnswer('也许', 'probably', meanings, M.EnToZh, false, undefined, undefined, { scorer });
    expect(r.isCorrect).toBe(true);
    expect(scorer).toHaveBeenCalledWith('也许', '或许');
    expect(r.semantic?.available).toBe(true);
    expect(r.semantic?.calls[0].score).toBe(0.72);
  });

  it('semanticEnabled=false 时不调用 scorer', async () => {
    const scorer = vi.fn();
    const r = await checkQuizAnswer(
      '也许', 'probably', meanings, M.EnToZh, false, undefined, undefined,
      { scorer, semanticEnabled: false },
    );
    expect(r.isCorrect).toBe(false);
    expect(scorer).not.toHaveBeenCalled();
    expect(r.semantic?.used).toBe(false);
  });

  it('scorer 不可用(available=false)时该片段按错误处理', async () => {
    const scorer = vi.fn().mockResolvedValue({ match: false, available: false });
    const r = await checkQuizAnswer('也许', 'probably', meanings, M.EnToZh, false, undefined, undefined, { scorer });
    expect(r.semantic?.available).toBe(false);
    expect(r.zhWrong).toEqual(['也许']);
  });
});

describe('错题义项权重 updateMeaningWeight(s)', () => {
  it('答对：correctCount++ 且权重 ×0.9', () => {
    const r = updateMeaningWeight({ weight: 1, errorCount: 0, correctCount: 0 }, true);
    expect(r.correctCount).toBe(1);
    expect(r.weight).toBeCloseTo(0.9);
  });
  it('答对降权有 0.1 下限', () => {
    const r = updateMeaningWeight({ weight: 0.1, errorCount: 2, correctCount: 3 }, true);
    expect(r.weight).toBeCloseTo(0.1);
  });
  it('答错（无初始记录）：errorCount=1 且权重 ×1.1', () => {
    const r = updateMeaningWeight(undefined, false);
    expect(r.errorCount).toBe(1);
    expect(r.weight).toBeCloseTo(1.1);
  });
  it('批量更新且不修改原 map', () => {
    const prev = { a: { weight: 1, errorCount: 0, correctCount: 0 } };
    const next = updateMeaningWeights(prev, ['a'], true);
    expect(next.a.weight).toBeCloseTo(0.9);
    expect(prev.a.weight).toBe(1);
  });
});
