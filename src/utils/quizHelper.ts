// 测验和复习模式共享的释义选择 & 答案检查逻辑

import { QuizMode } from '../types/enums';
import { normalizeNewlines } from './translation';
import { apiPost } from './api';

export interface MeaningItem {
  part: string;
  definition: string;
}

export interface WordData {
  word: string;
  phonetic?: string;
  meanings: MeaningItem[];
  isSentence?: boolean;
}

export interface SelectMeaningsResult {
  meanings: MeaningItem[];
  displayText: string;
}

export interface SemanticCallRecord {
  input: string;
  target: string;
  match: boolean;
  score?: number;
  latencyMs?: number;
}

export interface CheckAnswerResult {
  isCorrect: boolean;
  isPartial: boolean;
  /** EnToZh 单词模式：字符串匹配命中 / 未命中的用户释义片段（用于逐义项红绿纠错） */
  zhCorrect?: string[];
  zhWrong?: string[];
  /** EnToZh 单词模式：语义兜底的调用明细（供判题日志） */
  semantic?: {
    used: boolean;
    available: boolean;
    calls: SemanticCallRecord[];
  };
}

/** 语义打分器单次结果 */
export interface SemanticScoreResult {
  match: boolean;
  score?: number;
  latencyMs?: number;
  /** false = 打分器不可用（模型缺失 / 超时 / 报错） */
  available?: boolean;
}

/** 语义判分器：判断单个用户片段与某个正确义项是否语义等价 */
export type SemanticScorer = (userFragment: string, correctMeaning: string) => Promise<SemanticScoreResult>;

/** 批量判分器：一次判完全部配对（服务端按文本去重编码，消除 N+1 重复前向） */
export type SemanticBatchScorer = (
  pairs: Array<{ input: string; target: string }>
) => Promise<SemanticScoreResult[]>;

export interface CheckQuizOptions {
  /** 是否启用语义兜底，默认 true */
  semanticEnabled?: boolean;
  /** 语义判分器（逐对）；与 batchScorer 二选一，优先 batchScorer */
  scorer?: SemanticScorer;
  /** 批量语义判分器；缺省经本地后端 /api/semantic-similarity-batch（一次请求判完） */
  batchScorer?: SemanticBatchScorer;
}

// 默认批量适配器：一次请求判完全部配对（服务端 embedding 缓存 + 去重编码）。
// 失败时返回全不可用，调用方按字面匹配兜底，与原逐对行为一致。
const defaultHttpBatchScorer: SemanticBatchScorer = async (pairs) => {
  const t0 = Date.now();
  try {
    const r = await apiPost('/api/semantic-similarity-batch', {
      pairs: pairs.map(p => ({ text1: p.input, text2: p.target })),
    });
    const latencyMs = Date.now() - t0;
    if (r && r.success && r.data && Array.isArray(r.data.results)) {
      const results: SemanticScoreResult[] = r.data.results.map((x: any) => ({
        match: !!x.isSimilar,
        score: typeof x.score === 'number' ? x.score : undefined,
        latencyMs,
        available: r.data.available !== false,
      }));
      // 结果长度必须与配对一致，否则视为不可用，避免错位判分
      return results.length === pairs.length
        ? results
        : pairs.map(() => ({ match: false, latencyMs, available: false }));
    }
    return pairs.map(() => ({ match: false, latencyMs, available: false }));
  } catch {
    const latencyMs = Date.now() - t0;
    return pairs.map(() => ({ match: false, latencyMs, available: false }));
  }
};

// 常见词性标签白名单；不在此列表的标记（如 na.）直接忽略，避免显示成奇怪前缀
const VALID_POS_TAGS = new Set([
  'n', 'v', 'adj', 'adv', 'vt', 'vi', 'prep', 'conj', 'pron', 'art', 'num', 'int', 'aux',
  'a', 's', 'r', 'c', 'u',
  'pl', 'sing', 'abbr'
]);

function cleanTailBackslash(text: string): string {
  return text.replace(/\\+\s*$/, '').trim();
}

// 从释义中解析所有单个释义选项（拆分词性标记、分号、逗号）
function parseMeaningOptions(wordMeanings: MeaningItem[]): MeaningItem[] {
  const allOptions: MeaningItem[] = [];

  wordMeanings.forEach(meaning => {
    // CSV 导入的 translation 字段把换行符存成了字面量，先统一归一化
    const definitionText = normalizeNewlines(meaning.definition);
    // 匹配词性标记（如 n., vt.）和领域标记（如 [化], [医]）
    const partMatches = definitionText.match(/([a-z]+\.|\[[^\]]+\])/g) || [];

    if (partMatches.length > 0) {
      let lastIndex = 0;
      partMatches.forEach((partTag, idx) => {
        const partIndex = definitionText.indexOf(partTag, lastIndex);
        const nextPartIndex = idx < partMatches.length - 1
          ? definitionText.indexOf(partMatches[idx + 1], partIndex + partTag.length)
          : definitionText.length;

        const partDefinition = definitionText.substring(partIndex + partTag.length, nextPartIndex).trim();
        let cleanPartTag = '';

        if (partTag.startsWith('[')) {
          // 领域标签保持原样，让上层按"显示全部释义"设置过滤
          cleanPartTag = partTag;
        } else if (partTag.endsWith('.')) {
          // 标准词性保留，非标准词性（如 na.）置空
          const tagWithoutDot = partTag.replace('.', '');
          cleanPartTag = VALID_POS_TAGS.has(tagWithoutDot.toLowerCase()) ? tagWithoutDot : '';
        }

        const subGroups = partDefinition.split(/[；;]/).map(g => g.trim()).filter(g => g);
        subGroups.forEach(group => {
          const singleDefs = group.split(/[，,]/).map(d => cleanTailBackslash(d).trim()).filter(d => d);
          singleDefs.forEach(def => allOptions.push({ part: cleanPartTag, definition: def }));
        });

        lastIndex = nextPartIndex;
      });
    } else {
      const mainGroups = definitionText.split(/[；;]/).map(g => g.trim()).filter(g => g);
      mainGroups.forEach(group => {
        const singleDefs = group.split(/[，,]/).map(d => cleanTailBackslash(d).trim()).filter(d => d);
        let cleanPart = meaning.part || '';
        if (cleanPart.endsWith('.')) cleanPart = cleanPart.replace('.', '');
        if (cleanPart && !VALID_POS_TAGS.has(cleanPart.toLowerCase())) {
          cleanPart = '';
        }
        singleDefs.forEach(def => allOptions.push({ part: cleanPart, definition: def }));
      });
    }
  });

  return allOptions;
}

// 选择题目的释义：解析、过滤、按权重/词性选择
export function selectMeaningsForQuestion(
  wordMeanings: MeaningItem[],
  word: string,
  settings: {
    showAllMeanings: boolean;
    chineseCount: number;
    quizMultiPartProbability: number;
  },
  errorbook: Record<string, any>
): SelectMeaningsResult {
  let allOptions = parseMeaningOptions(wordMeanings);

  // 过滤领域标签（如 [化], [医] 等），除非勾选了"显示全部释义"
  if (!settings.showAllMeanings) {
    const filtered = allOptions.filter(item => !(item.part && item.part.startsWith('[')));
    // 过滤后不能为空，否则该题无法作答，回退到全部释义
    allOptions = filtered.length > 0 ? filtered : allOptions;
  }

  const selectedCount = settings.showAllMeanings
    ? allOptions.length
    : Math.min(settings.chineseCount, allOptions.length);

  const selectedMeanings: MeaningItem[] = [];

  if (selectedCount > 0) {
    // 错题本释义权重
    let meaningWeights: Record<string, { errorCount: number; correctCount: number; weight?: number }> | null = null;
    if (errorbook[word] && errorbook[word].meaningWeights) {
      meaningWeights = errorbook[word].meaningWeights;
    }

    const partGroups: Record<string, MeaningItem[]> = {};
    allOptions.forEach(item => {
      const key = item.part || '';
      if (!partGroups[key]) partGroups[key] = [];
      partGroups[key].push(item);
    });

    // 基于权重/随机选择释义
    const selectByWeight = (meanings: MeaningItem[]) => {
      if (!meaningWeights) {
        return meanings[Math.floor(Math.random() * meanings.length)];
      }
      let totalWeight = 0;
      const weightedItems = meanings.map(m => {
        const w = meaningWeights![m.definition] ? meaningWeights![m.definition].weight : 1;
        totalWeight += w;
        return { item: m, weight: w };
      });
      let r = Math.random() * totalWeight;
      for (const wi of weightedItems) {
        r -= wi.weight;
        if (r <= 0) return wi.item;
      }
      return meanings[0];
    };

    const uniqueParts = Object.keys(partGroups);
    const random = Math.random() * 100;

    if (uniqueParts.length > 1 && random < (settings.quizMultiPartProbability || 50)) {
      // 多词性模式：尽量从不同词性中选择
      const availableParts = [...uniqueParts];
      while (selectedMeanings.length < selectedCount && availableParts.length > 0) {
        const partIndex = Math.floor(Math.random() * availableParts.length);
        const selectedPart = availableParts[partIndex];
        const partMeanings = partGroups[selectedPart];
        if (partMeanings.length > 0) {
          const selectedItem = selectByWeight(partMeanings);
          selectedMeanings.push(selectedItem);
          const idx = partMeanings.indexOf(selectedItem);
          if (idx > -1) partMeanings.splice(idx, 1);
          if (partMeanings.length === 0) availableParts.splice(partIndex, 1);
        }
      }
      // 不够的话从剩余释义补充
      if (selectedMeanings.length < selectedCount) {
        const remaining = Object.values(partGroups).flat();
        while (selectedMeanings.length < selectedCount && remaining.length > 0) {
          const selectedItem = selectByWeight(remaining);
          selectedMeanings.push(selectedItem);
          const idx = remaining.indexOf(selectedItem);
          if (idx > -1) remaining.splice(idx, 1);
        }
      }
    } else {
      // 单词性模式：从释义最多的词性中选
      let bestPart = '';
      let maxMeanings = 0;
      for (const [part, meanings] of Object.entries(partGroups)) {
        if (meanings.length > maxMeanings) { maxMeanings = meanings.length; bestPart = part; }
      }
      const bestMeanings = partGroups[bestPart];
      while (selectedMeanings.length < selectedCount && bestMeanings.length > 0) {
        const selectedItem = selectByWeight(bestMeanings);
        selectedMeanings.push(selectedItem);
        const idx = bestMeanings.indexOf(selectedItem);
        if (idx > -1) bestMeanings.splice(idx, 1);
      }
      // 不够从其他词性补充
      if (selectedMeanings.length < selectedCount) {
        const otherParts = uniqueParts.filter(p => p !== bestPart);
        const otherMeanings = otherParts.flatMap(p => partGroups[p]);
        while (selectedMeanings.length < selectedCount && otherMeanings.length > 0) {
          const selectedItem = selectByWeight(otherMeanings);
          selectedMeanings.push(selectedItem);
          const idx = otherMeanings.indexOf(selectedItem);
          if (idx > -1) otherMeanings.splice(idx, 1);
        }
      }
    }
  }

  // 构建纯文本显示（用于 ZhToEn 模式展示中文释义）
  let displayText = '';
  let lastPart: string | null = null;
  selectedMeanings.forEach((item, idx) => {
    if (idx > 0) displayText += ' ';
    if (item.part && item.part !== lastPart) {
      if (item.part.startsWith('[')) {
        displayText += item.part;
      } else {
        displayText += item.part + '.';
      }
      lastPart = item.part;
    }
    displayText += item.definition;
  });

  return { meanings: selectedMeanings, displayText };
}

// 构建 ZhToEn 模式下的释义 HTML 展示（带 formatDefinitionHtml 回调）
export function buildMeaningDisplayHtml(
  selectedMeanings: MeaningItem[],
  formatDefinitionHtml: (def: string) => string
): string {
  let html = '';
  let lastPart: string | null = null;
  selectedMeanings.forEach((item, idx) => {
    if (idx > 0) html += ' ';
    if (item.part && item.part !== lastPart) {
      if (item.part.startsWith('[')) {
        html += `<span class="quiz-meaning-part">${item.part}</span>`;
      } else {
        html += `<span class="quiz-meaning-part">${item.part}.</span>`;
      }
      lastPart = item.part;
    }
    html += `<span>${formatDefinitionHtml(item.definition)}</span>`;
  });
  return html;
}

// 核心答案检查：不涉及 UI 更新、错题本、发音等，只判断对错
// EnToZh 模式下，字符串匹配失败后会调用语义相似度 API 做兜底判断
// 中文义项匹配：完全相等直接判对；子串命中需满足长度 / 覆盖率门槛，
// 避免「正确：苹果，输入：果」也判对；单字义项不做子串宽松匹配。
export function zhMeaningMatch(ua: string, cm: string): boolean {
  const u = ua.trim();
  const c = cm.trim();
  if (u === c) return true;
  if (!/[\u4e00-\u9fff]/.test(c)) return false;
  const la = [...u].length;
  const lc = [...c].length;
  if (lc <= 1) return false;
  if (c.includes(u)) return la >= 2 && la / lc >= 0.5;
  if (u.includes(c)) return lc >= 2;
  return false;
}

// 把 ECDict translation（如 "adv. 大概, 或许；很可能， 大概"）清洗成去重的中文释义片段，
// 供 EnToZh 判分并入正确释义集合
export function splitEcdictTranslation(t: string | undefined | null): string[] {
  if (!t) return [];
  const cleaned = t.replace(/\b(adv|adj|vt|vi|prep|conj|pron|num|art|int|det|aux|n|v)\.[\s]*/gi, ' ');
  const parts = cleaned.split(/[；;，,、\/]+/).map(x => x.trim()).filter(x => x.length > 0);
  return Array.from(new Set(parts));
}

export async function checkQuizAnswer(
  userAnswer: string,
  word: string,
  meanings: MeaningItem[],
  mode: QuizMode,
  isSentence: boolean,
  acceptableAnswers?: string[],
  extraCorrectMeanings?: string[],
  options?: CheckQuizOptions
): Promise<CheckAnswerResult> {
  const semanticEnabled = options?.semanticEnabled !== false;
  // 批量优先：默认走批量端点一次判完全部配对（服务端 embedding 缓存，消除 N+1 重复编码）；
  // 仅当显式注入逐对 scorer 时才逐对短路调用（兼容既有测试与调用方）。
  const batchScorer: SemanticBatchScorer | undefined =
    options?.batchScorer ?? (options?.scorer ? undefined : defaultHttpBatchScorer);
  const scorer: SemanticScorer | undefined = options?.scorer;
  let isCorrect = false;
  let isPartial = false;
  let zhCorrect: string[] | undefined;
  let zhWrong: string[] | undefined;
  const semanticCalls: SemanticCallRecord[] = [];
  let scorerAvailable: boolean | null = null;

  if (mode === QuizMode.ZhToEn || mode === QuizMode.Dictation || mode === QuizMode.Spelling || mode === QuizMode.ListeningStuck) {
    if (isSentence) {
      // 同时去除英文和中文标点，避免因标点差异误判
      const normalize = (s: string) => s.toLowerCase().replace(/[.,!?;:'""。，！？；：""'']/g, '').trim();
      isCorrect = normalize(userAnswer) === normalize(word);
    } else {
      // 单词：接受主拼写与全部可接受拼写（英美变体），统一大小写与多余空白
      const normWord = (x: string) => x.trim().toLowerCase().replace(/\s+/g, ' ');
      const candidates = acceptableAnswers && acceptableAnswers.length ? acceptableAnswers : [word];
      isCorrect = candidates.some(c => normWord(userAnswer) === normWord(c));
    }
  } else {
    // EnToZh 模式
    if (isSentence) {
      // 句子模式：使用字符重叠度判断（比重叠子串更可靠）
      // 当用户答案覆盖正确翻译 50% 以上字符时判定为正确
      if (meanings && meanings.length > 0 && meanings[0].definition) {
        const correctTranslation = meanings[0].definition;
        // 用 Set 去重，避免正确翻译中的重复字符被重复计数（如"啊啊啊啊"用户只输入"啊"会被误判为全覆盖）
        const correctChars = new Set([...correctTranslation]);
        const overlap = [...correctChars].filter((ch: string) => userAnswer.includes(ch)).length;
        const ratio = overlap / Math.max(correctChars.size, 1);
        isCorrect = ratio >= 0.5;
      }
    } else {
      const allCorrectMeanings: string[] = [];
      meanings.forEach(m => {
        const parts = m.definition.split(/[；;，,]/).map(p => p.trim()).filter(p => p.length > 0);
        parts.forEach(p => allCorrectMeanings.push(p));
      });
      // 并入 ECDict 附加释义：覆盖词书未列的同义说法（如 probably 的「或许」）
      (extraCorrectMeanings || []).forEach(p => {
        const t = (p || '').trim();
        if (t && !allCorrectMeanings.includes(t)) allCorrectMeanings.push(t);
      });

      const userAnswers = userAnswer.split(/[，,；;\s]+/).map(a => a.trim()).filter(a => a.length > 0);

      if (userAnswers.length === 0) {
        return { isCorrect: false, isPartial: false };
      }

      const correctUserAnswers: string[] = [];
      const wrongUserAnswers: string[] = [];

      // 先做字面匹配；仅对未命中的「片段 × 义项」配对收集语义判定。
      // 批量路径一次判完全部配对（服务端去重编码 + LRU 缓存），判定口径与逐对短路一致：
      // 某片段任一义项判对即该片段正确。短路只减少请求数量、不影响判定结果，
      // 批量多算的配对一并记入 semantic.calls 便于观测。
      interface PendingPair { fragment: string; meaning: string; }
      const pending: PendingPair[] = [];

      for (const ua of userAnswers) {
        const literal = allCorrectMeanings.some(cm => zhMeaningMatch(ua, cm));
        if (literal) {
          correctUserAnswers.push(ua);
          continue;
        }
        // 用户片段与每个正确义项【单独】配对：不能把多义项 join 成一串，
        // 否则同一词的不同义项（如 fantastic 的「极好的」与「怪诞的」）
        // 混在一起会互相拉低相似度，导致近义说法漏判。
        if (semanticEnabled) {
          for (const cm of allCorrectMeanings) {
            pending.push({ fragment: ua, meaning: cm });
          }
        } else {
          wrongUserAnswers.push(ua);
        }
      }

      if (semanticEnabled && pending.length > 0) {
        // fragment → 任一义项判对即该片段正确
        const fragmentMatch = new Map<string, boolean>();
        pending.forEach(p => { if (!fragmentMatch.has(p.fragment)) fragmentMatch.set(p.fragment, false); });

        if (batchScorer) {
          // 一次批量请求判完全部配对（默认走 /api/semantic-similarity-batch）
          const results = await batchScorer(pending.map(p => ({ input: p.fragment, target: p.meaning })));
          let available = false;
          pending.forEach((p, i) => {
            const r = results[i] || { match: false, available: false };
            semanticCalls.push({
              input: p.fragment,
              target: p.meaning,
              match: r.match,
              score: r.score,
              latencyMs: r.latencyMs,
            });
            if (r.available !== false) available = true;
            if (r.match) fragmentMatch.set(p.fragment, true);
          });
          scorerAvailable = available;
        } else if (scorer) {
          // 逐对注入路径（兼容既有测试 / 调用方）：短路到首个匹配的义项；
          // 打分器不可用时终止该片段的剩余义项扫描（与原实现 break 语义一致）
          const skipFragment = new Set<string>();
          for (const p of pending) {
            if (skipFragment.has(p.fragment) || fragmentMatch.get(p.fragment)) continue;
            const r = await scorer(p.fragment, p.meaning);
            semanticCalls.push({
              input: p.fragment,
              target: p.meaning,
              match: r.match,
              score: r.score,
              latencyMs: r.latencyMs,
            });
            if (r.available === false) {
              scorerAvailable = false;
              skipFragment.add(p.fragment);
              continue;
            }
            scorerAvailable = true;
            if (r.match) fragmentMatch.set(p.fragment, true);
          }
        } else {
          scorerAvailable = false;
        }

        for (const [fragment, matched] of fragmentMatch) {
          if (matched) correctUserAnswers.push(fragment);
          else wrongUserAnswers.push(fragment);
        }
      }

      zhCorrect = correctUserAnswers;
      zhWrong = wrongUserAnswers;

      if (correctUserAnswers.length === userAnswers.length) {
        isCorrect = true;
      } else if (correctUserAnswers.length > 0 && wrongUserAnswers.length > 0) {
        isPartial = true;
      }

      return {
        isCorrect,
        isPartial,
        zhCorrect,
        zhWrong,
        semantic: { used: semanticEnabled, available: scorerAvailable === true, calls: semanticCalls },
      };
    }
  }

  return { isCorrect, isPartial, zhCorrect, zhWrong };
}

// ===== 错题义项权重（纯函数） =====

export interface MeaningWeight {
  weight: number;
  errorCount: number;
  correctCount: number;
}

type MeaningWeightInput = { weight?: number; errorCount: number; correctCount: number };

/** 单次作答后更新单个义项权重：答对降权(×0.9，下限 0.1)，答错升权(×1.1) */
export function updateMeaningWeight(prev: MeaningWeightInput | undefined, isCorrect: boolean): MeaningWeight {
  const base: MeaningWeight = {
    weight: prev?.weight ?? 1,
    errorCount: prev?.errorCount ?? 0,
    correctCount: prev?.correctCount ?? 0,
  };
  if (isCorrect) {
    return { ...base, correctCount: base.correctCount + 1, weight: Math.max(0.1, base.weight * 0.9) };
  }
  return { ...base, errorCount: base.errorCount + 1, weight: base.weight * 1.1 };
}

/** 对一组义项批量更新权重（纯函数，返回新 map，不改原对象） */
export function updateMeaningWeights(
  prevMap: Record<string, MeaningWeightInput> | undefined,
  definitions: string[],
  isCorrect: boolean
): Record<string, MeaningWeight> {
  const next: Record<string, MeaningWeight> = {};
  for (const [k, v] of Object.entries(prevMap ?? {})) {
    next[k] = { weight: v.weight ?? 1, errorCount: v.errorCount, correctCount: v.correctCount };
  }
  for (const def of definitions) {
    next[def] = updateMeaningWeight(next[def], isCorrect);
  }
  return next;
}