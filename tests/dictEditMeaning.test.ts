import { describe, it, expect } from 'vitest';
import { parseEditable, rebuildTranslation, MeaningEntry } from '../electron/services/dictEdit/meaningEdit';

describe('parseEditable 可逆拆解', () => {
  it('多词性多义项拆条', () => {
    expect(parseEditable('n. 苹果；苹果树\nv. 结实')).toEqual([
      { pos: 'n.', text: '苹果' },
      { pos: 'n.', text: '苹果树' },
      { pos: 'v.', text: '结实' },
    ]);
  });
  it('行内词性拆段', () => {
    expect(parseEditable('废物vt. 废弃')).toEqual([
      { pos: '', text: '废物' },
      { pos: 'vt.', text: '废弃' },
    ]);
  });
  it('无词性行 pos 为空', () => {
    expect(parseEditable('尚在初期')).toEqual([{ pos: '', text: '尚在初期' }]);
  });
  it('非标词性（na.）整体保留为文本', () => {
    expect(parseEditable('na. 某某')).toEqual([{ pos: '', text: 'na. 某某' }]);
  });
  it('重复释义不去重', () => {
    expect(parseEditable('n. 苹果；苹果')).toEqual([
      { pos: 'n.', text: '苹果' },
      { pos: 'n.', text: '苹果' },
    ]);
  });
  it('跳过【自定义】行', () => {
    expect(parseEditable('n. 苹果\n【自定义】n. 自定义补充')).toEqual([{ pos: 'n.', text: '苹果' }]);
  });
  it('多种分隔符均可拆（；;，,、）', () => {
    expect(parseEditable('n. 苹果, 苹果树；果实、果子')).toEqual([
      { pos: 'n.', text: '苹果' },
      { pos: 'n.', text: '苹果树' },
      { pos: 'n.', text: '果实' },
      { pos: 'n.', text: '果子' },
    ]);
  });
  it('空值返回空数组', () => {
    expect(parseEditable('')).toEqual([]);
    expect(parseEditable(null)).toEqual([]);
    expect(parseEditable(undefined)).toEqual([]);
  });
});

describe('rebuildTranslation 重建', () => {
  it('连续同词性合并为一行', () => {
    const entries: MeaningEntry[] = [
      { pos: 'n.', text: '苹果' },
      { pos: 'n.', text: '苹果树' },
      { pos: 'v.', text: '结实' },
    ];
    expect(rebuildTranslation(entries)).toBe('n. 苹果；苹果树\nv. 结实');
  });
  it('改词性自动移组', () => {
    const entries: MeaningEntry[] = [
      { pos: 'n.', text: '苹果' },
      { pos: 'adj.', text: '苹果树' }, // 词性改为 adj
      { pos: 'n.', text: '果实' },
    ];
    expect(rebuildTranslation(entries)).toBe('n. 苹果\nadj. 苹果树\nn. 果实');
  });
  it('无词性条目不带前缀', () => {
    expect(rebuildTranslation([{ pos: '', text: '尚在初期' }])).toBe('尚在初期');
  });
  it('空数组重建为空串', () => {
    expect(rebuildTranslation([])).toBe('');
  });
  it('幂等：rebuild(parse(x)) 再 parse 条目不变', () => {
    const samples = [
      'n. 苹果；苹果树\nv. 结实',
      '废物vt. 废弃',
      'na. 某某',
      '尚在初期',
      'n. 苹果, 苹果树；果实、果子',
    ];
    for (const s of samples) {
      const once = parseEditable(s);
      expect(parseEditable(rebuildTranslation(once))).toEqual(once);
    }
  });
});
