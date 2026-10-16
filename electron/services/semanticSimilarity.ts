// 中文语义相似度判断模块
// 使用 Transformers.js 加载本地预训练模型，判断两段中文文本的语义相似度

import { pipeline, env, cos_sim } from '@huggingface/transformers';
import * as path from 'path';
import * as fs from 'fs';
import { CACHE_DIR, resolveAssetPath } from '../utils/helpers';

// 模型缓存目录
const MODEL_CACHE_DIR = path.join(CACHE_DIR, 'transformers_models');
if (!fs.existsSync(MODEL_CACHE_DIR)) {
  fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
}

// 配置 Transformers.js 使用本地缓存
env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = true;

// 使用本地模型路径(通过assets系统下载或打包在应用内)
const MODEL_PATH = resolveAssetPath('semantic-model-files');

let featureExtractor: any = null;
let modelLoadingPromise: Promise<any> | null = null;
let modelLoadFailed = false;

/**
 * 加载特征提取模型（懒加载，只加载一次）
 */
async function loadModel() {
  if (featureExtractor) return featureExtractor;
  if (modelLoadFailed) return null;
  if (modelLoadingPromise) return modelLoadingPromise;

  modelLoadingPromise = (async () => {
    // 检查本地模型目录是否存在
    if (!fs.existsSync(MODEL_PATH)) {
      console.warn('[SemanticSimilarity] 本地模型目录不存在:', MODEL_PATH);
      console.warn('[SemanticSimilarity] 请在设置中下载「语义相似度模型」');
      modelLoadFailed = true;
      return null;
    }

    console.log('[SemanticSimilarity] 开始加载本地模型:', MODEL_PATH);
    const start = Date.now();

    try {
      featureExtractor = await pipeline('feature-extraction', MODEL_PATH, {
        dtype: 'fp32',
      });
      console.log(`[SemanticSimilarity] 模型加载完成，耗时 ${Date.now() - start}ms`);
      return featureExtractor;
    } catch (err) {
      console.error('[SemanticSimilarity] 模型加载失败:', err);
      modelLoadingPromise = null;
      modelLoadFailed = true;
      return null;
    }
  })();

  return modelLoadingPromise;
}

/**
 * 计算两段文本的余弦相似度
 * @param text1 第一段文本
 * @param text2 第二段文本
 * @returns 相似度分数（0-1之间），失败返回 null
 */
export async function calculateSimilarity(text1: string, text2: string): Promise<number | null> {
  try {
    const [vec1, vec2] = await Promise.all([encodeText(text1), encodeText(text2)]);
    if (!vec1 || !vec2) return null;
    return cos_sim(vec1, vec2);
  } catch (err) {
    console.error('[SemanticSimilarity] 计算相似度失败:', err);
    return null;
  }
}

// ==================== embedding 缓存与批量判分 ====================
// 判题时「用户片段 × 正确义项」逐对比较，其中义项文本是反复出现的静态数据。
// 用 LRU 缓存文本 → 归一化向量，同一文本只前向一次；批量接口一次编码去重后的
// 全部文本，余弦相似度在 JS 内计算，消除 N+1 重复编码（D3）。

const EMBED_CACHE_MAX = 4000; // 约 4000 × 768 float32 ≈ 12MB，覆盖一轮测验全部义项绰绰有余
const embedCache = new Map<string, number[]>(); // key = trim 后的文本，Map 迭代序即插入序（近似 LRU）

/** 编码单个文本（mean-pool + L2 归一化），命中缓存不触发模型前向 */
export async function encodeText(text: string): Promise<number[] | null> {
  const key = text.trim();
  if (!key) return null;
  const cached = embedCache.get(key);
  if (cached) {
    // 命中后移到末尾，保持 LRU 淘汰顺序
    embedCache.delete(key);
    embedCache.set(key, cached);
    return cached;
  }
  try {
    const extractor = await loadModel();
    if (!extractor) return null;
    const out = await extractor(key, { pooling: 'mean', normalize: true });
    const vec = Array.from(out.data as Float32Array);
    if (embedCache.size >= EMBED_CACHE_MAX) {
      const oldest = embedCache.keys().next().value;
      if (oldest !== undefined) embedCache.delete(oldest);
    }
    embedCache.set(key, vec);
    return vec;
  } catch (err) {
    console.error('[SemanticSimilarity] 文本编码失败:', err);
    return null;
  }
}

export interface SemanticPairInput {
  text1: string;
  text2: string;
}

export interface SemanticPairResult {
  isSimilar: boolean;
  score: number | null;
  /** 本轮批量判分总耗时（供判题日志观测，逐对前向耗时已摊销到缓存） */
  latencyMs: number;
}

export interface SemanticBatchResult {
  /** false = 模型不可用（未下载 / 加载失败），调用方按字面匹配兜底 */
  available: boolean;
  results: SemanticPairResult[];
}

/**
 * 批量判分：一次编码去重后的全部文本（缓存命中跳过），再逐对算余弦。
 * 判定语义与逐对 evaluateSemanticSimilarity 完全一致（同一阈值、同一向量口径）。
 */
export async function evaluateSemanticBatch(
  pairs: SemanticPairInput[],
  threshold: number = 0.58
): Promise<SemanticBatchResult> {
  const empty = (latencyMs: number): SemanticBatchResult => ({
    available: false,
    results: pairs.map(() => ({ isSimilar: false, score: null, latencyMs })),
  });

  const extractor = await loadModel();
  if (!extractor) return empty(0);

  const t0 = Date.now();
  try {
    // 去重后逐个编码：缓存命中的文本零成本，未命中的只前向一次
    const uniqueTexts = Array.from(new Set(
      pairs.flatMap(p => [p.text1.trim(), p.text2.trim()]).filter(t => t.length > 0)
    ));
    const vecMap = new Map<string, number[] | null>();
    for (const t of uniqueTexts) {
      vecMap.set(t, await encodeText(t));
    }

    const latencyMs = Date.now() - t0;
    const results = pairs.map(p => {
      const v1 = vecMap.get(p.text1.trim());
      const v2 = vecMap.get(p.text2.trim());
      if (!v1 || !v2) return { isSimilar: false, score: null, latencyMs };
      const score = cos_sim(v1, v2);
      return { isSimilar: score >= threshold, score, latencyMs };
    });
    return { available: true, results };
  } catch (err) {
    console.error('[SemanticSimilarity] 批量判分失败:', err);
    return empty(Date.now() - t0);
  }
}

/**
 * 判断两段文本是否语义相似
 * @param userInput 用户输入
 * @param correctAnswer 正确答案
 * @param threshold 相似度阈值（默认0.58）
 * @returns 是否相似，模型不可用时返回 false
 */
export interface SemanticEvalResult {
  similar: boolean;
  score: number | null;
  threshold: number;
}

/** 同时给出是否相似与余弦分数（供 API 返回与判题日志记录） */
export async function evaluateSemanticSimilarity(
  userInput: string,
  correctAnswer: string,
  threshold: number = 0.58
): Promise<SemanticEvalResult> {
  const similarity = await calculateSimilarity(userInput, correctAnswer);
  if (similarity === null) return { similar: false, score: null, threshold };
  console.log(`[SemanticSimilarity] "${userInput}" vs "${correctAnswer}" = ${similarity.toFixed(3)} (阈值: ${threshold})`);
  return { similar: similarity >= threshold, score: similarity, threshold };
}

export async function checkSemanticSimilarity(
  userInput: string,
  correctAnswer: string,
  threshold: number = 0.58
): Promise<boolean> {
  return (await evaluateSemanticSimilarity(userInput, correctAnswer, threshold)).similar;
}

/**
 * 预加载模型（可选，在应用启动时调用）
 */
export async function preloadModel(): Promise<void> {
  try {
    await loadModel();
  } catch (err) {
    console.error('[SemanticSimilarity] 预加载模型失败:', err);
  }
}
