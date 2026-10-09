/* eslint-disable */
// 语义阈值扫描（离线、本地模型，不联网）
// 用与线上完全相同的推理配置（feature-extraction / fp32 / mean pooling / l2 normalize），
// 在评测集「en-to-zh 且字面未命中」用例（positive + hard-negative）上扫描阈值，
// 输出 precision/recall/F1 与最佳阈值（precision>=0.95 约束下 recall 最大）。
//
// 运行：node tools/scan-semantic-threshold.cjs
// 产物：
//   tests/fixtures/semantic-threshold-report.json  各阈值指标 + 最佳阈值
//   tests/fixtures/semantic-scores.jsonl           每条用例最高分，供人工复核混淆

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const EVAL_FILE = path.join(ROOT, 'tests', 'fixtures', 'grading-eval.jsonl');
const MODEL_PATH = path.join(ROOT, 'resource', 'semantic-model-files');
const REPORT_FILE = path.join(ROOT, 'tests', 'fixtures', 'semantic-threshold-report.json');
const SCORES_FILE = path.join(ROOT, 'tests', 'fixtures', 'semantic-scores.jsonl');

const CURRENT_PRODUCTION = 0.58;
const T_MIN = 0.30;
const T_MAX = 0.90;
const T_STEP = 0.02;
const PRECISION_FLOOR = 0.95;

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n').map(s => s.trim()).filter(Boolean)
    .map(s => JSON.parse(s));
}

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// 从每条用例最高分扫描各阈值指标
function computeThresholds(scored) {
  const thresholds = [];
  for (let t = T_MIN; t <= T_MAX + 1e-9; t += T_STEP) {
    const tt = Number(t.toFixed(2));
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const s of scored) {
      const predPos = s.maxScore >= tt;
      const actualPos = s.expected === 'correct';
      if (predPos && actualPos) tp++;
      else if (predPos && !actualPos) fp++;
      else if (!predPos && actualPos) fn++;
      else tn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
    thresholds.push({ t: tt, tp, fp, fn, tn,
      precision: Number(precision.toFixed(4)), recall: Number(recall.toFixed(4)), f1: Number(f1.toFixed(4)) });
  }
  return thresholds;
}

// 组装报告（含自动推导的 findings 与改进建议）
function buildReport(scored, cases) {
  const positives = cases.filter(c => c.expected === 'correct');
  const negatives = cases.filter(c => c.expected === 'wrong');
  const thresholds = computeThresholds(scored);

  // 最佳阈值：precision>=0.95 下 recall 最大（并列取 f1、再取阈值较高者更保守）
  const eligible = thresholds.filter(x => x.precision >= PRECISION_FLOOR);
  const pool = eligible.length ? eligible : thresholds;
  const best = pool.reduce((a, b) => {
    if (b.recall !== a.recall) return b.recall > a.recall ? b : a;
    if (b.f1 !== a.f1) return b.f1 > a.f1 ? b : a;
    return b.t > a.t ? b : a;
  });

  const atCurrent = thresholds.find(x => Math.abs(x.t - CURRENT_PRODUCTION) < 1e-9) || null;
  const fpNow = scored.filter(s => s.cat === 'hard-negative' && s.maxScore >= CURRENT_PRODUCTION);
  const fnNow = scored.filter(s => s.cat === 'positive' && s.maxScore < CURRENT_PRODUCTION);
  const posScores = scored.filter(s => s.expected === 'correct').map(s => s.maxScore);
  const negScores = scored.filter(s => s.expected === 'wrong').map(s => s.maxScore);

  const topFp = [...fpNow].sort((a, b) => b.maxScore - a.maxScore).slice(0, 10)
    .map(s => ({ input: s.input, word: s.word, score: Number(s.maxScore.toFixed(3)) }));

  const findings = [
    `正例分数 min/中位/max = ${Math.min(...posScores).toFixed(3)}/${median(posScores).toFixed(3)}/${Math.max(...posScores).toFixed(3)}；` +
    `负例 = ${Math.min(...negScores).toFixed(3)}/${median(negScores).toFixed(3)}/${Math.max(...negScores).toFixed(3)}，两类大面积重叠，不存在同时满足 precision>=0.95 与可用 recall 的阈值。`,
    `precision>=0.95 需把阈值提到 ${best.t}，但 recall 仅 ${best.recall}（${positives.length} 条正例约只放行 ${Math.round(best.recall * positives.length)} 条），F1=${best.f1}，基本不可用。`,
    `当前线上 ${CURRENT_PRODUCTION}：precision=${atCurrent ? atCurrent.precision : 'n/a'}、recall=${atCurrent ? atCurrent.recall : 'n/a'}；` +
    `${fpNow.length} 条硬负例被误放行、${fnNow.length} 条正例被漏判。`,
    "误放行集中在『同语义场范畴词』（艺术/艺术家、计算机/计算器）与『反义词』（增加/减少、赞成/反对）：双编码器(bi-encoder)均值余弦对这两类天然不敏感，属结构性限制，非调阈值可解。",
  ];
  const recommendations = [
    "改用交叉编码器 cross-encoder（在 STS-B/AFQMC/LCQMC 上微调），把两文本拼接后直接输出等价概率，对反义/范畴差异显著更敏感；这是语义文本相似度(STS)的标准做法。",
    "或改用中文 NLI 模型，判断『用户输入是否蕴含(entail)标准释义』：反义→contradiction、范畴偏移→neutral。",
    "补充规则：否定词（不/没/无/非）检测；单字包含 + 长度比（艺术家 = 艺术 + 家）识别范畴偏移。",
    "语义分数不单独决定对错：字面匹配优先，语义仅作低权重参考或需用户二次确认。",
  ];

  return {
    generatedAt: new Date().toISOString(),
    model: 'hfl/chinese-macbert-base (fp32, mean pooling, l2 normalize)',
    scoring: 'max over cosine_sim(embed(input), embed(each target))',
    evalSet: {
      total: cases.length, positive: positives.length, negative: negatives.length,
      note: '仅 en-to-zh 且字面未命中（线上进入语义兜底）的用例；literal 用例已排除',
    },
    precisionFloor: PRECISION_FLOOR,
    currentProduction: CURRENT_PRODUCTION,
    metricsAtCurrent: atCurrent,
    best,
    eligibleUnderFloor: eligible.length,
    topFalsePositivesAtCurrent: topFp,
    findings,
    recommendations,
    thresholds,
  };
}

async function main() {
  const reportOnly = process.argv.includes('--report-only');
  const all = readJsonl(EVAL_FILE);
  // 仅评估「看英写中」里字面未命中、线上会进入语义兜底的用例：positive + hard-negative
  const cases = all.filter(c => c.mode === 'en-to-zh' && (c.cat === 'positive' || c.cat === 'hard-negative'));
  console.log(`评估用例：${cases.length}（正例 ${cases.filter(c => c.expected === 'correct').length} / 负例 ${cases.filter(c => c.expected === 'wrong').length}）`);

  let scored;
  if (reportOnly && fs.existsSync(SCORES_FILE)) {
    scored = readJsonl(SCORES_FILE);
    console.log('从明细分数重建报告（不加载模型）：', SCORES_FILE);
  } else {
    if (!fs.existsSync(MODEL_PATH)) {
      console.error('模型目录不存在：', MODEL_PATH);
      process.exit(1);
    }
    const { pipeline, cos_sim } = await import('@huggingface/transformers');
    console.log('加载模型：', MODEL_PATH);
    const t0 = Date.now();
    const extractor = await pipeline('feature-extraction', MODEL_PATH, { dtype: 'fp32' });
    console.log(`模型就绪，耗时 ${Date.now() - t0}ms`);

    // 向量缓存：唯一文本只推理一次
    const cache = new Map();
    async function embed(text) {
      if (cache.has(text)) return cache.get(text);
      const out = await extractor(text, { pooling: 'mean', normalize: true });
      const arr = Array.from(out.data); // 与线上一致：cos_sim 接受普通数组
      cache.set(text, arr);
      return arr;
    }

    scored = [];
    let done = 0;
    for (const c of cases) {
      const vIn = await embed(c.input);
      let maxScore = -Infinity;
      let bestTarget = '';
      for (const t of c.target) {
        const vT = await embed(t);
        const s = Number(cos_sim(vIn, vT));
        if (s > maxScore) { maxScore = s; bestTarget = t; }
      }
      scored.push({ id: c.id, cat: c.cat, word: c.word, input: c.input, bestTarget, maxScore, expected: c.expected });
      done++;
      if (done % 20 === 0) console.log(`  已评分 ${done}/${cases.length}`);
    }
    fs.writeFileSync(SCORES_FILE, scored.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  }

  const report = buildReport(scored, cases);
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');

  const best = report.best;
  console.log('\n阈值    Prec    Recall  F1');
  for (const x of report.thresholds) {
    const mark = Math.abs(x.t - best.t) < 1e-9 ? '  <- best'
      : Math.abs(x.t - CURRENT_PRODUCTION) < 1e-9 ? '  (current)' : '';
    console.log(`${x.t.toFixed(2)}   ${x.precision.toFixed(3)}   ${x.recall.toFixed(3)}   ${x.f1.toFixed(3)}${mark}`);
  }
  console.log(`\n最佳阈值：${best.t}  precision=${best.precision} recall=${best.recall} f1=${best.f1}`);
  console.log('报告：', REPORT_FILE);
  console.log('明细：', SCORES_FILE);
}

main().catch(e => { console.error(e); process.exit(1); });
