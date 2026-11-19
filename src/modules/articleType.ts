// 文章练习模块：把 CET4/6 阅读真题的整篇文章逐句做「跟打」或「听写」。
// 跟打：看句打字，浅色 ghost 铺底，逐字符对绿错红；听写：隐藏文本，放音凭记忆敲整句。
// 数据复用 public/exams/reading（与模拟题同源），发音复用 utils/audio 的句子发音。

import { escapeHtml, appState } from '../global';
import { playSentencePronunciation } from '../utils/audio';
import { buildArticleSentences } from '../utils/articleSentences';

const BASE_URL = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const EXAM_URL = `${BASE_URL}/exams`;
const PAGE_ID = 'article-type-page';

interface RArticle { n: number; t: string; p: string[]; src?: string; section?: string; paperTitle?: string; year?: number }
interface ReadingFile { level: string; label: string; count: number; articles: RArticle[] }
type Level = 'cet4' | 'cet6';
type Mode = 'follow' | 'dictation';
type SrcFilter = 'all' | 'mock' | 'real';
type View = 'home' | 'list' | 'practice';

// ---------------- 模块状态 ----------------
let view: View = 'home';
let level: Level = 'cet4';
let mode: Mode = 'follow';
let srcFilter: SrcFilter = loadSrcFilter();
const cache: Partial<Record<Level, ReadingFile>> = {};
const counts: Record<Level, { mock: number; real: number; total: number }> = {
    cet4: { mock: 0, real: 0, total: 0 },
    cet6: { mock: 0, real: 0, total: 0 },
};

let articlePos = 0;
let sentences: string[] = [];
let sentencePos = 0;
let typed = '';
let revealed = false;       // 听写：是否已查看答案
let completed = false;      // 整篇是否完成
let mistakes = 0;          // 错误击键次数（跟打）
let advanceTimer: ReturnType<typeof setTimeout> | null = null;

function el(): HTMLElement {
    return document.getElementById(PAGE_ID) as HTMLElement;
}
function accent(): string {
    return appState.settings.pronunciationType || 'us';
}
function render(html: string): void {
    const box = el();
    if (box) box.innerHTML = html;
    window.scrollTo({ top: 0 });
}
async function fetchJson<T>(url: string): Promise<T> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`资源加载失败 (${r.status})`);
    return (await r.json()) as T;
}

/** 归一化比较：小写 + 折叠空白 */
function norm(s: string): string {
    return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function loadSrcFilter(): SrcFilter {
    try {
        const v = localStorage.getItem('at-src-filter');
        return v === 'mock' || v === 'real' ? v : 'all';
    } catch { return 'all'; }
}
function saveSrcFilter(v: SrcFilter): void {
    try { localStorage.setItem('at-src-filter', v); } catch { /* ignore */ }
}
function isReal(a: RArticle): boolean { return a.src === 'real'; }
async function prefetchCounts(): Promise<void> {
    for (const lv of ['cet4', 'cet6'] as Level[]) {
        try {
            if (!cache[lv]) cache[lv] = await fetchJson<ReadingFile>(`${EXAM_URL}/reading/${lv}.json`);
            const f = cache[lv]!;
            const real = f.articles.filter(isReal).length;
            counts[lv] = { mock: f.articles.length - real, real, total: f.articles.length };
        } catch { /* 留空，首页回退文案 */ }
    }
    if (view === 'home') renderHome();
}

// ---------------- 首页 ----------------
function renderHome(): void {
    view = 'home';
    render(`
    <div class="at-home">
      <h1>文章练习</h1>
      <p class="at-home-sub">把阅读素材整篇逐句敲出来，训练整句拼写与记忆。覆盖「模拟题」与「历年真题」（仔细阅读 / 长篇匹配 / 选词填空），列表内可按来源筛选。</p>
      <div class="at-mode-info">
        <div class="at-mode-card glass">
          <span class="at-mode-icon">⌨️</span>
          <h3>跟打模式</h3>
          <p>显示完整句子，浅色铺底，逐字符输入，对的变绿、错的变红，敲完自动进下一句。</p>
        </div>
        <div class="at-mode-card glass">
          <span class="at-mode-icon">🎧</span>
          <h3>听写模式</h3>
          <p>隐藏句子，自动播放发音，可重播；凭记忆敲出整句，完成后对照原文。</p>
        </div>
      </div>
      <div class="at-level-cards">
        <div class="at-level-card glass">
          <h2>CET-4 阅读</h2>
          <p>${counts.cet4.total ? `${counts.cet4.total} 篇（模拟 ${counts.cet4.mock} · 真题 ${counts.cet4.real}）` : '加载中…'} · 句子相对短</p>
          <button class="btn ex-primary" data-action="at-list" data-level="cet4">进入四级文章</button>
        </div>
        <div class="at-level-card glass">
          <h2>CET-6 阅读</h2>
          <p>${counts.cet6.total ? `${counts.cet6.total} 篇（模拟 ${counts.cet6.mock} · 真题 ${counts.cet6.real}）` : '加载中…'} · 句子更长</p>
          <button class="btn ex-primary" data-action="at-list" data-level="cet6">进入六级文章</button>
        </div>
      </div>
    </div>`);
}

// ---------------- 列表 ----------------
async function openList(lv: Level): Promise<void> {
    level = lv;
    view = 'list';
    render('<div class="ex-loading">正在加载文章…</div>');
    try {
        if (!cache[lv]) {
            cache[lv] = await fetchJson<ReadingFile>(`${EXAM_URL}/reading/${lv}.json`);
        }
        renderList();
    } catch (e) {
        console.error('加载文章失败', e);
        render(`
          <div class="ex-error glass">
            <h2>未找到文章资源</h2>
            <p>请确认阅读数据已构建（public/exams/reading）。</p>
            <button class="btn ex-secondary" data-action="at-home">返回</button>
          </div>`);
    }
}

function renderList(): void {
    view = 'list';
    const f = cache[level];
    if (!f) return;
    const realCount = f.articles.filter(isReal).length;
    const mockCount = f.articles.length - realCount;
    const showAll = srcFilter === 'all';
    // data-pos 用全量下标，保证筛选后 startPractice 仍能定位到正确文章
    const items = f.articles.map((a, i) => {
        if (!showAll && (srcFilter === 'real') !== isReal(a)) return '';
        const real = isReal(a);
        return `
      <button class="ex-list-item" data-action="at-open" data-pos="${i}">
        <span class="ex-list-no">${a.n}</span>
        <span class="ex-list-title">${escapeHtml(a.t)}</span>
        <span class="at-src-badge ${real ? 'real' : 'mock'}">${real ? '真题' : '模拟题'}</span>
      </button>`;
    }).join('');
    const shown = showAll ? f.articles.length : (srcFilter === 'real' ? realCount : mockCount);
    render(`
    <div class="ex-list-page">
      <div class="ex-topbar">
        <button class="btn ex-ghost" data-action="at-home">‹ 返回</button>
        <div class="ex-topbar-title">
          <h1>${escapeHtml(f.label)} · 文章练习</h1>
          <span class="ex-topbar-meta">${shown} 篇（模拟 ${mockCount} · 真题 ${realCount}）</span>
        </div>
      </div>
      <div class="at-mode-switch glass">
        <span>素材来源</span>
        <button class="at-switch-btn ${srcFilter === 'all' ? 'active' : ''}" data-action="at-src" data-src="all">全部</button>
        <button class="at-switch-btn ${srcFilter === 'mock' ? 'active' : ''}" data-action="at-src" data-src="mock">模拟题</button>
        <button class="at-switch-btn ${srcFilter === 'real' ? 'active' : ''}" data-action="at-src" data-src="real">历年真题</button>
      </div>
      <div class="at-mode-switch glass">
        <span>练习方式</span>
        <button class="at-switch-btn ${mode === 'follow' ? 'active' : ''}" data-action="at-mode" data-mode="follow">⌨️ 跟打</button>
        <button class="at-switch-btn ${mode === 'dictation' ? 'active' : ''}" data-action="at-mode" data-mode="dictation">🎧 听写</button>
      </div>
      <div class="ex-list-grid">${items}</div>
    </div>`);
}

// ---------------- 练习 ----------------
function startPractice(pos: number): void {
    const f = cache[level];
    if (!f) return;
    articlePos = Math.max(0, Math.min(pos, f.articles.length - 1));
    const article = f.articles[articlePos];
    sentences = buildArticleSentences(article.p);
    sentencePos = 0;
    resetSentenceState();
    completed = false;
    mistakes = 0;
    if (!sentences.length) {
        render(`
        <div class="ex-error glass">
          <h2>本篇不适合英文练习</h2>
          <p>该文章没有可提取的英文句子（可能是中文文章或数据缺失）。</p>
          <button class="btn ex-secondary" data-action="at-back-list">返回列表</button>
        </div>`);
        return;
    }
    renderPractice();
}

function resetSentenceState(): void {
    if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
    typed = '';
    revealed = false;
}

function currentSentence(): string {
    return sentences[sentencePos] || '';
}

function renderPractice(): void {
    view = 'practice';
    const f = cache[level];
    if (!f || !sentences.length) return;

    if (completed) { renderSummary(); return; }

    const target = currentSentence();
    const isDict = mode === 'dictation';
    const total = sentences.length;
    const progressPct = Math.round((sentencePos / total) * 100);

    render(`
    <div class="at-practice">
      <div class="ex-topbar">
        <button class="btn ex-ghost" data-action="at-back-list">‹ 文章列表</button>
        <div class="ex-topbar-title">
          <h1>${escapeHtml(f.articles[articlePos].t)}</h1>
          <span class="ex-topbar-meta">${isDict ? '🎧 听写' : '⌨️ 跟打'} · 第 ${sentencePos + 1}/${total} 句</span>
        </div>
      </div>

      <div class="at-progress">
        <div class="at-progress-fill" style="width:${progressPct}%"></div>
      </div>

      <div class="at-sentence-card glass">
        ${isDict && !revealed
            ? `<div class="at-dict-head">
                 <p class="at-dict-hint">听发音，凭记忆敲出整句（可点重播）</p>
                 <button class="btn ex-primary" data-action="at-play">🔊 播放 / 重播发音</button>
               </div>`
            : `<div class="at-sentence-meta">
                 <button class="btn ex-secondary" data-action="at-play">🔊</button>
                 <span class="at-mode-tag">${isDict ? '听写 · 原文对照' : '跟打 · 看句打字'}</span>
               </div>`}

        <div class="at-type-area" id="at-type-area">
          <div class="at-type-display" id="at-display">${charDisplayHtml(target)}</div>
          <input type="text" id="at-input" autocomplete="off" autocapitalize="off" spellcheck="false"
                 aria-label="文章练习输入框">
        </div>

        <div class="at-controls">
          <button class="btn ex-secondary" data-action="at-reveal">${isDict ? '查看答案' : '显示答案'}</button>
          <button class="btn ex-ghost" data-action="at-skip">跳过本句</button>
        </div>
      </div>
    </div>`);

    bindInput();
    const input = document.getElementById('at-input') as HTMLInputElement;
    input.focus();
    if (isDict) {
        // 进入句子自动播放
        void playSentencePronunciation(accent(), target);
    }
}

type Piece = { kind: 'char' | 'space' | 'caret'; html: string };

/**
 * 把字符片段按词分组：连续非空格片段包进不可断行的 .at-word，
 * 换行只允许发生在空格处，避免一个单词被折行拆开。
 */
function groupWords(pieces: Piece[]): string {
    let out = '';
    let buf: string[] = [];
    const flush = () => {
        if (buf.length) {
            out += `<span class="at-word">${buf.join('')}</span>`;
            buf = [];
        }
    };
    for (const p of pieces) {
        if (p.kind === 'space') {
            flush();
            out += p.html;
        } else {
            buf.push(p.html);
        }
    }
    flush();
    return out;
}

/** 构建逐字符展示 HTML（跟打 ghost；听写未揭晓只回显输入），按词分组保证不在词中断行 */
function charDisplayHtml(target: string): string {
    const isDict = mode === 'dictation';
    const showTarget = !isDict || revealed;
    const caret = '<span class="tc tc-caret"></span>';
    const charSpan = (ch: string, cls: string): Piece => ({
        kind: 'char',
        html: `<span class="${cls}">${escapeHtml(ch)}</span>`,
    });
    const spacePiece: Piece = { kind: 'space', html: '<span class="at-space"> </span>' };

    const pieces: Piece[] = [];
    let wrong = 0;
    const L = Math.max(target.length, typed.length);

    if (showTarget) {
        for (let i = 0; i < L; i++) {
            if (i === typed.length) pieces.push({ kind: 'caret', html: caret });
            if (i < typed.length) {
                const ch = typed[i];
                const tc = target[i];
                if (ch === ' ') {
                    pieces.push(spacePiece);
                } else {
                    if (!(wrong === 0 && tc && ch.toLowerCase() === tc.toLowerCase())) wrong++;
                    pieces.push(charSpan(ch, wrong === 0 ? 'tc tc-ok' : 'tc tc-bad'));
                }
            } else {
                const ch = target[i];
                if (ch === ' ') pieces.push(spacePiece);
                else pieces.push(charSpan(ch, 'tc tc-ghost'));
            }
        }
        if (typed.length >= target.length) pieces.push({ kind: 'caret', html: caret });
    } else {
        // 听写未揭晓：只回显已输入字符（中性色），不暴露目标
        for (let i = 0; i < typed.length; i++) {
            if (typed[i] === ' ') pieces.push(spacePiece);
            else pieces.push(charSpan(typed[i], 'tc tc-neutral'));
        }
        pieces.push({ kind: 'caret', html: caret });
    }
    return groupWords(pieces);
}

/** 仅刷新字符展示，不整页重渲染，避免输入丢焦 */
function refreshDisplay(): void {
    const display = document.getElementById('at-display');
    if (display) display.innerHTML = charDisplayHtml(currentSentence());
}

function bindInput(): void {
    const input = document.getElementById('at-input') as HTMLInputElement | null;
    if (!input) return;
    input.addEventListener('input', () => {
        const target = currentSentence();
        // 跟打：统计新增错误击键
        if (mode === 'follow' && input.value.length > typed.length) {
            const i = input.value.length - 1;
            const tc = target[i];
            if (!(tc && input.value[i].toLowerCase() === tc.toLowerCase())) mistakes++;
        }
        typed = input.value;
        if (revealed) revealed = false;
        refreshDisplay();
        maybeAutoAdvance();
    });
}

function maybeAutoAdvance(): void {
    const target = currentSentence();
    if (typed.length === 0 || norm(typed) !== norm(target)) return;
    if (advanceTimer) clearTimeout(advanceTimer);
    advanceTimer = setTimeout(() => {
        advanceTimer = null;
        nextSentence();
    }, 260);
}

function revealAnswer(): void {
    if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; }
    const input = document.getElementById('at-input') as HTMLInputElement | null;
    if (input) {
        // 把正确答案填入，展示对照
        input.value = currentSentence();
        typed = currentSentence();
    }
    revealed = true;
    refreshDisplay();
}

function playCurrent(): void {
    void playSentencePronunciation(accent(), currentSentence());
}

function nextSentence(): void {
    if (sentencePos >= sentences.length - 1) {
        completed = true;
        renderPractice();
        return;
    }
    sentencePos++;
    resetSentenceState();
    renderPractice();
}

function skipSentence(): void {
    nextSentence();
}

// ---------------- 完成总结 ----------------
function renderSummary(): void {
    const f = cache[level];
    render(`
    <div class="at-summary glass">
      <h2>本篇完成 🎉</h2>
      <p class="at-summary-meta">${escapeHtml(f?.articles[articlePos].t || '')}</p>
      <div class="at-summary-stats">
        <div><strong>${sentences.length}</strong><span>句子数</span></div>
        <div><strong>${mistakes}</strong><span>错误击键</span></div>
      </div>
      <div class="at-summary-actions">
        <button class="btn ex-primary" data-action="at-open" data-pos="${articlePos}">再练本篇</button>
        <button class="btn ex-secondary" data-action="at-back-list">返回列表</button>
        <button class="btn ex-ghost" data-action="at-home">回首页</button>
      </div>
    </div>`);
}

// ---------------- 事件委托 ----------------
async function onClick(e: MouseEvent): Promise<void> {
    const node = (e.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
    if (!node || !el().contains(node)) return;
    const action = node.dataset.action;
    switch (action) {
        case 'at-home':
            renderHome();
            break;
        case 'at-list':
            await openList((node.dataset.level as Level) || 'cet4');
            break;
        case 'at-back-list':
            await openList(level);
            break;
        case 'at-mode':
            mode = (node.dataset.mode as Mode) || 'follow';
            renderList();
            break;
        case 'at-src':
            srcFilter = (node.dataset.src as SrcFilter) || 'all';
            saveSrcFilter(srcFilter);
            renderList();
            break;
        case 'at-open':
            startPractice(Number(node.dataset.pos));
            break;
        case 'at-play':
            playCurrent();
            break;
        case 'at-reveal':
            revealAnswer();
            break;
        case 'at-skip':
            skipSentence();
            break;
        default:
            break;
    }
}

export function initArticleType(): void {
    const box = el();
    if (!box) return;
    renderHome();
    void prefetchCounts();
    box.addEventListener('click', (e: MouseEvent) => {
        void onClick(e);
    });
}

