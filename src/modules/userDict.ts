// 词库管理：用户词典（user_dict）的列表、新增/编辑、隐藏/恢复/删除、CSV 导入导出
// 数据存独立 SQLite（user_dict.db），与 stardict 词典分离，保存后查词立即生效

import { openModal, closeModal, showConfirm, showAlert, escapeHtml } from '../global';
import { showToast } from '../utils/gsap';
import { apiGet, apiPost, apiPut, apiDelete, apiPostForm } from '../utils/api';
import { searchWord } from './dictionary';

type UserDictItem = {
    id: number;
    word: string;
    word_display: string;
    word_type: string;
    translation: string;
    definition: string;
    example: string;
    example_trans: string;
    tags: string;
    is_custom: number;
    override_mode: string;
    hidden: number;
};

const TYPE_LABELS: Record<string, string> = {
    noun: '名词', adj: '形容词', verb: '动词', adv: '副词',
    phrase: '词组', idiom: '短语', sentence: '句子',
};

let editingId: number | null = null;
let currentItems: UserDictItem[] = [];

function $(id: string): HTMLElement | null {
    return document.getElementById(id);
}

function getModal(): HTMLElement | null {
    return $('user-dict-modal');
}

// ==================== 视图切换 ====================

function showListView(): void {
    $('user-dict-list-view')!.style.display = 'flex';
    $('user-dict-form-view')!.style.display = 'none';
}

function showFormView(item?: UserDictItem): void {
    editingId = item ? item.id : null;
    $('user-dict-list-view')!.style.display = 'none';
    const form = $('user-dict-form-view')!;
    form.style.display = 'flex';
    $('user-dict-form-title')!.textContent = item ? `编辑词条：${item.word_display || item.word}` : '新增词条';

    ($('user-dict-f-word') as HTMLInputElement).value = item ? (item.word_display || item.word) : '';
    ($('user-dict-f-word') as HTMLInputElement).disabled = !!item; // 编辑时词条不可改（word 为归一化主键）
    ($('user-dict-f-type') as HTMLSelectElement).value = item ? item.word_type : 'phrase';
    ($('user-dict-f-translation') as HTMLInputElement).value = item ? item.translation : '';
    ($('user-dict-f-definition') as HTMLInputElement).value = item ? item.definition : '';
    ($('user-dict-f-example') as HTMLInputElement).value = item ? item.example : '';
    ($('user-dict-f-example-trans') as HTMLInputElement).value = item ? item.example_trans : '';
    ($('user-dict-f-tags') as HTMLInputElement).value = item ? item.tags : '';
    ($('user-dict-f-override') as HTMLSelectElement).value = item && item.override_mode === 'replace' ? 'replace' : 'merge';
    $('user-dict-f-hint')!.textContent = '';
    $('user-dict-f-hint')!.style.color = '';
    void probeWord();
}

// ==================== 列表渲染 ====================

function renderItems(items: UserDictItem[], total: number): void {
    const list = $('user-dict-list')!;
    $('user-dict-count')!.textContent = total > items.length ? `共 ${total} 条（显示前 ${items.length} 条）` : `共 ${total} 条`;
    if (items.length === 0) {
        list.innerHTML = '<div class="user-dict-empty">暂无词条，点击「新增词条」添加，或导入 CSV</div>';
        return;
    }
    list.innerHTML = items.map(it => {
        const typeLabel = TYPE_LABELS[it.word_type] || it.word_type;
        const badges: string[] = [];
        if (it.hidden) badges.push('<span class="user-dict-badge user-dict-badge-hidden">已隐藏</span>');
        else if (it.is_custom === 0) badges.push('<span class="user-dict-badge user-dict-badge-custom">自定义释义</span>');
        else badges.push('<span class="user-dict-badge user-dict-badge-own">自建</span>');
        return `
        <div class="user-dict-item" data-id="${it.id}">
            <div class="user-dict-item-main">
                <div class="user-dict-item-head">
                    <span class="user-dict-item-word">${escapeHtml(it.word_display || it.word)}</span>
                    <span class="user-dict-item-type">${escapeHtml(typeLabel)}</span>
                    ${badges.join('')}
                </div>
                <div class="user-dict-item-trans">${escapeHtml(it.translation || '（仅隐藏标记）')}</div>
                ${it.example ? `<div class="user-dict-item-example">${escapeHtml(it.example)}${it.example_trans ? ' ｜ ' + escapeHtml(it.example_trans) : ''}</div>` : ''}
            </div>
            <div class="user-dict-item-actions">
                <button class="user-dict-btn user-dict-btn-sm" data-op="edit" data-id="${it.id}">编辑</button>
                ${it.hidden
                    ? `<button class="user-dict-btn user-dict-btn-sm" data-op="unhide" data-id="${it.id}">恢复</button>`
                    : `<button class="user-dict-btn user-dict-btn-sm" data-op="hide" data-id="${it.id}">隐藏</button>`}
                <button class="user-dict-btn user-dict-btn-sm user-dict-btn-danger" data-op="delete" data-id="${it.id}">删除</button>
            </div>
        </div>`;
    }).join('');
}

// ==================== 数据操作 ====================

async function loadList(): Promise<void> {
    try {
        const q = encodeURIComponent(($('user-dict-search') as HTMLInputElement).value.trim());
        const type = ($('user-dict-type-filter') as HTMLSelectElement).value;
        const hidden = ($('user-dict-show-hidden') as HTMLInputElement).checked ? 'true' : 'false';
        const r = await apiGet(`/api/user-dict?q=${q}&type=${type}&include_hidden=${hidden}&limit=200`);
        if (r && r.success && r.data) {
            currentItems = r.data.items || [];
            renderItems(currentItems, r.data.total || 0);
        }
    } catch (e) {
        console.error('[UserDict] 加载列表失败:', e);
    }
}

/** 表单 word 失焦探测：词典已有 → 提示将自定义释义 */
async function probeWord(): Promise<void> {
    const word = ($('user-dict-f-word') as HTMLInputElement).value.trim();
    const hint = $('user-dict-f-hint')!;
    const overrideRow = $('user-dict-f-override-row')!;
    if (!word) {
        hint.textContent = '';
        overrideRow.style.display = 'none';
        return;
    }
    try {
        const r = await apiGet(`/api/user-dict/word/${encodeURIComponent(word)}`);
        if (r && r.success && r.data) {
            if (r.data.stardict_exists) {
                hint.textContent = '词典中已有该词，保存后将以「自定义释义」形式追加/替换显示';
                hint.style.color = '#e67e22';
                overrideRow.style.display = 'flex';
            } else {
                hint.textContent = '词库中暂无该词，保存后新建词条';
                hint.style.color = '#7f8c8d';
                overrideRow.style.display = 'none';
            }
        }
    } catch { /* 探测失败不阻塞表单 */ }
}

async function saveItem(): Promise<void> {
    const word = ($('user-dict-f-word') as HTMLInputElement).value.trim();
    const translation = ($('user-dict-f-translation') as HTMLInputElement).value.trim();
    if (!word) { void showAlert('请输入词条'); return; }
    if (!translation) { void showAlert('请输入中文翻译'); return; }
    const body = {
        word,
        word_type: ($('user-dict-f-type') as HTMLSelectElement).value,
        translation,
        definition: ($('user-dict-f-definition') as HTMLInputElement).value.trim(),
        example: ($('user-dict-f-example') as HTMLInputElement).value.trim(),
        example_trans: ($('user-dict-f-example-trans') as HTMLInputElement).value.trim(),
        tags: ($('user-dict-f-tags') as HTMLInputElement).value.trim(),
        override_mode: ($('user-dict-f-override') as HTMLSelectElement).value,
    };
    try {
        const r = editingId != null
            ? await apiPut(`/api/user-dict/${editingId}`, body)
            : await apiPost('/api/user-dict', body);
        if (r && r.success) {
            showToast('已保存', 'success');
            showListView();
            await loadList();
            await refreshDictResult();
        } else {
            void showAlert((r && r.error && (r.error.message || r.error)) || '保存失败');
        }
    } catch (e: any) {
        // 409 冲突等
        const msg = String(e && e.message ? e.message : e);
        void showAlert(msg.includes('已存在') ? '词条已存在，请改为编辑该词条' : `保存失败：${msg}`);
    }
}

async function deleteItem(id: number): Promise<void> {
    try {
        const r = await apiDelete(`/api/user-dict/${id}`);
        if (r && r.success) {
            showToast(r.data && r.data.restored ? '已删除自定义条目，恢复词典原释义' : '已删除', 'success');
            await loadList();
            await refreshDictResult();
        }
    } catch (e) {
        console.error('[UserDict] 删除失败:', e);
        void showAlert('删除失败');
    }
}

async function setItemHidden(id: number, hidden: boolean): Promise<void> {
    try {
        const r = await apiPost(`/api/user-dict/${id}/${hidden ? 'hide' : 'unhide'}`, {});
        if (r && r.success) {
            showToast(hidden ? '已隐藏，搜索不再显示' : '已恢复', 'success');
            await loadList();
            await refreshDictResult();
        }
    } catch (e) {
        console.error('[UserDict] 隐藏/恢复失败:', e);
        void showAlert('操作失败');
    }
}

/** 保存/隐藏/删除后立即刷新词典当前查询结果（即时生效） */
export async function refreshDictResult(): Promise<void> {
    try {
        const searchInput = document.getElementById('word') as HTMLInputElement | null;
        const currentWord = searchInput ? searchInput.value.trim() : '';
        if (currentWord) await searchWord(currentWord);
    } catch { /* 词典页不可见等场景静默 */ }
}

// ==================== CSV 导入导出 ====================

async function importCsv(file: File): Promise<void> {
    const fd = new FormData();
    fd.append('file', file);
    try {
        const r = await apiPostForm('/api/user-dict/import', fd);
        if (r && r.success) {
            const d = r.data || {};
            let msg = `导入完成：新增 ${d.added || 0} 条，更新 ${d.updated || 0} 条`;
            if (d.errors && d.errors.length > 0) {
                msg += `，跳过 ${d.errors.length} 条（格式问题）`;
                console.warn('[UserDict] CSV 行级错误:', d.errors);
            }
            void showAlert(msg);
            await loadList();
            await refreshDictResult();
        } else {
            void showAlert((r && r.error && (r.error.message || r.error)) || '导入失败');
        }
    } catch (e: any) {
        void showAlert(`导入失败：${e && e.message ? e.message : e}`);
    }
}

async function exportCsv(): Promise<void> {
    try {
        const response = await fetch('/api/user-dict/export');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'user_dict.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (e: any) {
        void showAlert(`导出失败：${e && e.message ? e.message : e}`);
    }
}

// ==================== 初始化 ====================

export function initUserDict(): void {
    const modal = getModal();
    const link = $('user-dict-link');
    if (!modal || !link) return;

    const open = (e?: Event) => {
        if (e) e.preventDefault();
        showListView();
        openModal(modal);
        void loadList();
    };
    const close = () => closeModal(modal);

    link.addEventListener('click', open);
    $('user-dict-close')!.addEventListener('click', close);
    $('user-dict-done')!.addEventListener('click', close);
    modal.addEventListener('click', (e: MouseEvent) => {
        if (e.target === modal) close();
    });

    // 标签切换：我的备注 / 词库修改（词库修改面板由 dictEdit 模块接管）
    modal.querySelectorAll<HTMLButtonElement>('.user-dict-tab').forEach((tab) => {
        tab.addEventListener('click', () => {
            const name = tab.dataset.tab;
            modal.querySelectorAll('.user-dict-tab').forEach(t => t.classList.toggle('active', t === tab));
            const note = $('user-dict-tab-note');
            const edit = $('user-dict-tab-edit');
            if (note) note.style.display = name === 'note' ? 'flex' : 'none';
            if (edit) edit.style.display = name === 'edit' ? 'flex' : 'none';
        });
    });

    // 工具条
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    ($('user-dict-search') as HTMLInputElement).addEventListener('input', () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => void loadList(), 300);
    });
    ($('user-dict-type-filter') as HTMLSelectElement).addEventListener('change', () => void loadList());
    ($('user-dict-show-hidden') as HTMLInputElement).addEventListener('change', () => void loadList());
    $('user-dict-add')!.addEventListener('click', () => showFormView());
    $('user-dict-import')!.addEventListener('click', () => ($('user-dict-import-file') as HTMLInputElement).click());
    ($('user-dict-import-file') as HTMLInputElement).addEventListener('change', (e: Event) => {
        const input = e.target as HTMLInputElement;
        if (input.files && input.files.length > 0) {
            void importCsv(input.files[0]);
            input.value = '';
        }
    });
    $('user-dict-export')!.addEventListener('click', () => void exportCsv());

    // 列表行操作（事件委托）
    $('user-dict-list')!.addEventListener('click', async (e: Event) => {
        const btn = (e.target as HTMLElement).closest('button[data-op]') as HTMLButtonElement | null;
        if (!btn) return;
        const id = parseInt(btn.dataset.id || '', 10);
        const op = btn.dataset.op;
        if (!Number.isInteger(id)) return;

        if (op === 'edit') {
            const item = currentItems.find(x => x.id === id);
            if (item) showFormView(item);
        } else if (op === 'hide') {
            if (await showConfirm('确定要隐藏该词条吗？隐藏后搜索不再显示，可随时恢复。', '隐藏确认')) {
                await setItemHidden(id, true);
            }
        } else if (op === 'unhide') {
            await setItemHidden(id, false);
        } else if (op === 'delete') {
            if (await showConfirm('确定要删除该词条吗？自建词条删除后不可恢复。', '删除确认')) {
                await deleteItem(id);
            }
        }
    });

    // 表单
    ($('user-dict-f-word') as HTMLInputElement).addEventListener('blur', () => void probeWord());
    $('user-dict-f-save')!.addEventListener('click', () => void saveItem());
    $('user-dict-f-cancel')!.addEventListener('click', () => {
        showListView();
        void loadList();
    });
}
