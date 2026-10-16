// 词库修改：释义级编辑（新增/编辑/删除单条、删除某词性全部）+ 版本留痕（撤销/重做/恢复版本）
// 直接修改 stardict.db 的 translation 字段，保存后查词立即生效；
// 修改记录存 user_dict.db（dict_edit_history），保留 14 天。
// 所有破坏性操作先二次确认，确认后才调用 API（body 带 confirm: true）。

import { showConfirm, showAlert, escapeHtml } from '../global';
import { showToast } from '../utils/gsap';
import { apiGet, apiPost } from '../utils/api';
import { refreshDictResult } from './userDict';

interface MeaningEntry {
    pos: string;  // 带点形态 'n.'/'vt.' 或 ''
    text: string;
}

interface HistoryState {
    head_seq: number;
    latest_seq: number;
    can_undo: boolean;
    can_redo: boolean;
}

interface HistoryItem {
    seq: number;
    action: string;
    summary: string;
    created_at: string;
    is_head: boolean;
}

let currentWord = '';
let currentEntries: MeaningEntry[] = [];
let currentHistory: HistoryState = { head_seq: 0, latest_seq: 0, can_undo: false, can_redo: false };
let posOptions: string[] = ['n.', 'v.', 'vt.', 'vi.', 'adj.', 'adv.', 'prep.', 'conj.', 'pron.', 'num.', 'int.', 'art.'];
// 正在编辑的条目下标；-1 = 新增模式；null = 无编辑
let editingIndex: number | null = null;

const ACTION_LABELS: Record<string, string> = {
    original: '原始词库数据',
    edit: '修改释义',
    add: '新增释义',
    delete: '删除释义',
    restore: '恢复版本',
};

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function tabEditActive(): boolean {
    const edit = $('user-dict-tab-edit');
    return !!edit && edit.style.display !== 'none';
}

// ==================== 数据加载 ====================

async function loadWord(word: string): Promise<void> {
    const w = (word || '').trim();
    if (!w) {
        void showAlert('请输入要修改的英文单词');
        return;
    }
    try {
        const r = await apiGet(`/api/dict-edit/word/${encodeURIComponent(w)}`);
        if (r && r.success && r.data) {
            currentWord = r.data.word.word;
            currentEntries = Array.isArray(r.data.entries) ? r.data.entries : [];
            currentHistory = r.data.history || { head_seq: 0, latest_seq: 0, can_undo: false, can_redo: false };
            if (Array.isArray(r.data.pos_options) && r.data.pos_options.length > 0) {
                posOptions = r.data.pos_options;
            }
            editingIndex = null;
            renderStatusBar(r.data.user_override);
            renderWordHead(r.data.word);
            renderEntries();
            ($('dict-edit-view')!).style.display = 'flex';
            ($('dict-edit-history-view')!).style.display = 'none';
        } else {
            void showAlert('加载失败');
        }
    } catch (e: any) {
        const msg = String(e && e.message ? e.message : e);
        if (msg.includes('404') || msg.includes('没有该词条')) {
            void showAlert('词库中没有该词条。若要新建自定义词条，请切换到「我的备注」标签。');
        } else {
            void showAlert(`加载失败：${msg}`);
        }
    }
}

async function loadHistory(): Promise<void> {
    if (!currentWord) return;
    try {
        const r = await apiGet(`/api/dict-edit/word/${encodeURIComponent(currentWord)}/history`);
        if (r && r.success && r.data) {
            currentHistory = r.data.state || currentHistory;
            renderHistoryList(r.data.items || []);
            ($('dict-edit-view')!).style.display = 'none';
            ($('dict-edit-history-view')!).style.display = 'flex';
        }
    } catch (e: any) {
        void showAlert(`获取版本历史失败：${e && e.message ? e.message : e}`);
    }
}

/** 保存成功后：重拉当前词 + 刷新词典查询结果 */
async function reloadAfterChange(): Promise<void> {
    await loadWord(currentWord);
    await refreshDictResult();
}

// ==================== 渲染 ====================

function renderStatusBar(userOverride: any): void {
    const bar = $('dict-edit-status-bar')!;
    const notes: string[] = [];
    if (userOverride) {
        if (userOverride.hidden) {
            notes.push('该词在「我的备注」中已被隐藏，搜索不显示；词库修改不受影响');
        } else {
            const mode = userOverride.override_mode === 'replace' ? '替换词典释义' : '合并显示';
            notes.push(`该词在「我的备注」中有自定义释义（${mode}）；词库修改改的是词典原释义`);
        }
    }
    if (notes.length === 0) {
        bar.style.display = 'none';
        return;
    }
    bar.style.display = 'block';
    bar.innerHTML = notes.map(n => `<div>${escapeHtml(n)}</div>`).join('');
}

function renderWordHead(word: { word: string; phonetic: string }): void {
    $('dict-edit-word')!.textContent = word.word;
    $('dict-edit-phonetic')!.textContent = word.phonetic ? `/${word.phonetic}/` : '';
    ($('dict-edit-undo') as HTMLButtonElement).disabled = !currentHistory.can_undo;
    ($('dict-edit-redo') as HTMLButtonElement).disabled = !currentHistory.can_redo;
}

function posSelectHtml(selected: string): string {
    const opts = [...posOptions];
    if (selected && !opts.includes(selected)) opts.unshift(selected);
    return `<select class="dict-edit-pos-select" aria-label="词性">
        <option value="">（无词性）</option>
        ${opts.map(p => `<option value="${escapeHtml(p)}" ${p === selected ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
    </select>`;
}

function renderEntries(): void {
    const box = $('dict-edit-entries')!;
    if (currentEntries.length === 0 && editingIndex !== -1) {
        box.innerHTML = '<div class="user-dict-empty">暂无释义。点击「新增释义」添加；留痕恢复可找回原释义</div>';
        return;
    }

    // 按词性分组（按首次出现顺序），保留原始下标用于编辑/删除
    const groupMap = new Map<string, number[]>();
    currentEntries.forEach((en, i) => {
        const key = (en.pos || '').trim();
        const arr = groupMap.get(key);
        if (arr) arr.push(i);
        else groupMap.set(key, [i]);
    });

    const parts: string[] = [];
    // 新增表单置顶
    if (editingIndex === -1) {
        parts.push(`
        <div class="dict-edit-card editing">
            ${posSelectHtml('')}
            <input type="text" class="dict-edit-text-input" placeholder="释义内容，如 苹果" value="">
            <div class="dict-edit-card-actions">
                <button class="user-dict-btn user-dict-btn-sm user-dict-btn-primary" data-op="save-add">添加</button>
                <button class="user-dict-btn user-dict-btn-sm" data-op="cancel-edit">取消</button>
            </div>
        </div>`);
    }

    for (const [pos, indices] of groupMap) {
        const posLabel = pos || '无词性';
        parts.push(`
        <div class="dict-edit-group">
            <div class="dict-edit-group-head">
                <span class="dict-edit-pos">${escapeHtml(posLabel)}</span>
                ${indices.length > 1 ? `<button class="user-dict-btn user-dict-btn-sm user-dict-btn-danger" data-op="del-pos" data-pos="${escapeHtml(pos)}">删除该词性全部（共 ${indices.length} 条）</button>` : ''}
            </div>
            ${indices.map(i => {
                const en = currentEntries[i];
                if (editingIndex === i) {
                    return `
                    <div class="dict-edit-card editing" data-index="${i}">
                        ${posSelectHtml(en.pos)}
                        <input type="text" class="dict-edit-text-input" value="${escapeHtml(en.text)}">
                        <div class="dict-edit-card-actions">
                            <button class="user-dict-btn user-dict-btn-sm user-dict-btn-primary" data-op="save-edit" data-index="${i}">保存</button>
                            <button class="user-dict-btn user-dict-btn-sm" data-op="cancel-edit">取消</button>
                        </div>
                    </div>`;
                }
                return `
                <div class="dict-edit-card" data-index="${i}">
                    <div class="dict-edit-card-text">${escapeHtml(en.text)}</div>
                    <div class="dict-edit-card-actions">
                        <button class="user-dict-btn user-dict-btn-sm" data-op="edit" data-index="${i}">编辑</button>
                        <button class="user-dict-btn user-dict-btn-sm user-dict-btn-danger" data-op="del" data-index="${i}">删除</button>
                    </div>
                </div>`;
            }).join('')}
        </div>`);
    }
    box.innerHTML = parts.join('');
}

function renderHistoryList(items: HistoryItem[]): void {
    const box = $('dict-edit-history-list')!;
    if (items.length === 0) {
        box.innerHTML = '<div class="user-dict-empty">暂无修改记录（仅显示原始词库数据）</div>';
        return;
    }
    // 新版本在上
    const sorted = [...items].sort((a, b) => b.seq - a.seq);
    box.innerHTML = sorted.map(it => {
        const label = ACTION_LABELS[it.action] || it.action;
        return `
        <div class="dict-edit-history-item ${it.is_head ? 'is-head' : ''}">
            <div class="dict-edit-history-main">
                <div class="dict-edit-history-head">
                    <span class="dict-edit-history-seq">#${it.seq}</span>
                    <span class="dict-edit-history-action">${escapeHtml(label)}</span>
                    ${it.is_head ? '<span class="user-dict-badge user-dict-badge-custom">当前版本</span>' : ''}
                </div>
                ${it.summary ? `<div class="dict-edit-history-summary">${escapeHtml(it.summary)}</div>` : ''}
                ${it.created_at ? `<div class="dict-edit-history-time">${escapeHtml(it.created_at)}</div>` : ''}
            </div>
            <div class="dict-edit-card-actions">
                ${it.is_head
                    ? '<button class="user-dict-btn user-dict-btn-sm" disabled>当前版本</button>'
                    : `<button class="user-dict-btn user-dict-btn-sm user-dict-btn-primary" data-op="restore" data-seq="${it.seq}">恢复到此版本</button>`}
            </div>
        </div>`;
    }).join('');
}

// ==================== 写操作（均需二次确认） ====================

/** 通用提交：确认 → POST entries → 重拉 + 刷新查词 */
async function submitEntries(action: string, summary: string, next: MeaningEntry[], confirmMsg: string): Promise<void> {
    if (!(await showConfirm(confirmMsg, '修改确认'))) return;
    try {
        const r = await apiPost(`/api/dict-edit/word/${encodeURIComponent(currentWord)}/entries`, {
            entries: next,
            action,
            summary,
            expected_head_seq: currentHistory.head_seq,
            confirm: true,
        });
        if (r && r.success) {
            showToast('已保存，查词立即生效', 'success');
            await reloadAfterChange();
        } else {
            void showAlert((r && r.error && (r.error.message || r.error)) || '保存失败');
        }
    } catch (e: any) {
        await handleWriteError(e);
    }
}

async function handleWriteError(e: any): Promise<void> {
    const msg = String(e && e.message ? e.message : e);
    if (msg.includes('409') || msg.includes('版本状态已变化')) {
        void showAlert('版本状态已变化（可能在其他窗口被修改），已刷新为最新数据，请重新操作');
        await loadWord(currentWord);
    } else if (msg.includes('400')) {
        void showAlert(msg.replace(/^HTTP [0-9]+:\s*/, '').replace(/^\{.*"message"\s*:\s*"([^"]+)".*\}$/, '$1') || '操作无效');
    } else {
        void showAlert(`操作失败：${msg}`);
    }
}

async function saveEdit(index: number, pos: string, text: string): Promise<void> {
    const old = currentEntries[index];
    if (!text.trim()) {
        void showAlert('释义内容不能为空');
        return;
    }
    const next = currentEntries.map((en, i) => i === index ? { pos: pos.trim(), text: text.trim() } : en);
    await submitEntries('edit', `修改释义：${old.text} → ${text.trim()}`, next, '确定保存对该条释义的修改吗？');
}

async function addEntry(pos: string, text: string): Promise<void> {
    if (!text.trim()) {
        void showAlert('释义内容不能为空');
        return;
    }
    const next = [...currentEntries, { pos: pos.trim(), text: text.trim() }];
    await submitEntries('add', `新增释义：${text.trim()}`, next, '确定新增该条释义吗？');
}

async function deleteEntry(index: number): Promise<void> {
    const en = currentEntries[index];
    if (!(await showConfirm(`确定删除该条释义吗？\n「${en.text}」\n删除后可通过「撤销」或「版本历史」恢复。`, '删除确认'))) return;
    const next = currentEntries.filter((_, i) => i !== index);
    try {
        const r = await apiPost(`/api/dict-edit/word/${encodeURIComponent(currentWord)}/entries`, {
            entries: next,
            action: 'delete',
            summary: `删除释义：${en.text}`,
            expected_head_seq: currentHistory.head_seq,
            confirm: true,
        });
        if (r && r.success) {
            showToast('已删除，可撤销恢复', 'success');
            await reloadAfterChange();
        } else {
            void showAlert((r && r.error && (r.error.message || r.error)) || '删除失败');
        }
    } catch (e: any) {
        await handleWriteError(e);
    }
}

async function deletePosGroup(pos: string): Promise<void> {
    const count = currentEntries.filter(en => (en.pos || '').trim() === pos.trim()).length;
    const posLabel = pos.trim() || '无词性';
    if (!(await showConfirm(`确定删除「${posLabel}」的全部 ${count} 条释义吗？\n删除后可通过「撤销」或「版本历史」恢复。`, '删除确认'))) return;
    const next = currentEntries.filter(en => (en.pos || '').trim() !== pos.trim());
    await submitEntries('delete', `删除 ${posLabel} 全部释义（${count} 条）`, next, '确定删除吗？');
}

/** 撤销 / 重做：可逆操作不再弹确认（API 端仍要求 confirm 字段） */
async function doUndoRedo(kind: 'undo' | 'redo'): Promise<void> {
    try {
        const r = await apiPost(`/api/dict-edit/word/${encodeURIComponent(currentWord)}/${kind}`, {
            expected_head_seq: currentHistory.head_seq,
            confirm: true,
        });
        if (r && r.success) {
            showToast(kind === 'undo' ? '已撤销' : '已重做', 'success');
            await reloadAfterChange();
        } else {
            void showAlert((r && r.error && (r.error.message || r.error)) || '操作失败');
        }
    } catch (e: any) {
        await handleWriteError(e);
    }
}

async function restoreVersion(seq: number): Promise<void> {
    const label = seq === 0 ? '原始词库数据' : `版本 #${seq}`;
    if (!(await showConfirm(`确定恢复到「${label}」吗？\n恢复操作会生成新版本，之后仍可撤销或再恢复其他版本。`, '恢复确认'))) return;
    try {
        const r = await apiPost(`/api/dict-edit/word/${encodeURIComponent(currentWord)}/restore`, {
            seq,
            expected_head_seq: currentHistory.head_seq,
            confirm: true,
        });
        if (r && r.success) {
            showToast(`已恢复到${label}`, 'success');
            await loadHistory();
            await refreshDictResult();
        } else {
            void showAlert((r && r.error && (r.error.message || r.error)) || '恢复失败');
        }
    } catch (e: any) {
        await handleWriteError(e);
    }
}

// ==================== 初始化 ====================

export function initDictEdit(): void {
    const loadBtn = $('dict-edit-load');
    const searchInput = $('dict-edit-search') as HTMLInputElement | null;
    if (!loadBtn || !searchInput) return;

    // 载入词条（按钮 / 回车）
    loadBtn.addEventListener('click', () => void loadWord(searchInput.value));
    searchInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            void loadWord(searchInput.value);
        }
    });

    // 工具行
    $('dict-edit-add')!.addEventListener('click', () => {
        editingIndex = -1;
        renderEntries();
        const input = $('dict-edit-entries')!.querySelector('.dict-edit-text-input') as HTMLInputElement | null;
        if (input) input.focus();
    });
    $('dict-edit-undo')!.addEventListener('click', () => void doUndoRedo('undo'));
    $('dict-edit-redo')!.addEventListener('click', () => void doUndoRedo('redo'));
    $('dict-edit-history-btn')!.addEventListener('click', () => void loadHistory());
    $('dict-edit-history-back')!.addEventListener('click', () => {
        ($('dict-edit-history-view')!).style.display = 'none';
        ($('dict-edit-view')!).style.display = 'flex';
    });

    // 释义卡片操作（事件委托）
    $('dict-edit-entries')!.addEventListener('click', (e: Event) => {
        const btn = (e.target as HTMLElement).closest('button[data-op]') as HTMLButtonElement | null;
        if (!btn) return;
        const op = btn.dataset.op;
        const index = parseInt(btn.dataset.index || '', 10);

        if (op === 'edit' && Number.isInteger(index)) {
            editingIndex = index;
            renderEntries();
        } else if (op === 'cancel-edit') {
            editingIndex = null;
            renderEntries();
        } else if (op === 'save-edit' && Number.isInteger(index)) {
            const card = btn.closest('.dict-edit-card')!;
            const pos = (card.querySelector('.dict-edit-pos-select') as HTMLSelectElement).value;
            const text = (card.querySelector('.dict-edit-text-input') as HTMLInputElement).value;
            void saveEdit(index, pos, text);
        } else if (op === 'save-add') {
            const card = btn.closest('.dict-edit-card')!;
            const pos = (card.querySelector('.dict-edit-pos-select') as HTMLSelectElement).value;
            const text = (card.querySelector('.dict-edit-text-input') as HTMLInputElement).value;
            void addEntry(pos, text);
        } else if (op === 'del' && Number.isInteger(index)) {
            void deleteEntry(index);
        } else if (op === 'del-pos') {
            void deletePosGroup(btn.dataset.pos || '');
        }
    });

    // 版本历史操作（事件委托）
    $('dict-edit-history-list')!.addEventListener('click', (e: Event) => {
        const btn = (e.target as HTMLElement).closest('button[data-op="restore"]') as HTMLButtonElement | null;
        if (!btn) return;
        const seq = parseInt(btn.dataset.seq || '', 10);
        if (Number.isInteger(seq)) void restoreVersion(seq);
    });

    // Ctrl+Z / Ctrl+Y：仅在词库修改标签激活且焦点不在输入框时生效
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (!tabEditActive()) return;
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
        if (!(e.ctrlKey || e.metaKey)) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
            e.preventDefault();
            void doUndoRedo('undo');
        } else if (key === 'y' || (key === 'z' && e.shiftKey)) {
            e.preventDefault();
            void doUndoRedo('redo');
        }
    });
}
