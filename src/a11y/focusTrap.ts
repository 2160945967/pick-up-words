// 模态框统一无障碍：焦点陷阱 / Esc 关闭 / 焦点回归
// 仅接管静态存在于 index.html 的说明/设置类弹窗；global.ts 动态创建的
// custom-prompt-modal（confirm/alert/prompt）自带 Esc/Enter 与聚焦，不接管。

const STATIC_IDS = [
    'ebbinghaus-modal', 'import-format-modal', 'due-words-condition-modal',
    'api-settings-modal', 'asset-manage-modal', 'usage-guide-modal',
    'book-picker-modal',
];

// 避免 getComputedStyle 在高频 DOM 变动（输入 / 动画 / 虚拟列表）下强制回流导致掉帧
function isVisible(el: HTMLElement): boolean {
    return !!el && !!el.style && el.style.display !== 'none';
}

// 取当前最顶层可见的 .modal-overlay（z-index 最大者）
function getTopModal(): HTMLElement | null {
    const all = document.querySelectorAll<HTMLElement>('.modal-overlay');
    let top: HTMLElement | null = null;
    let maxZ = -1;
    all.forEach(el => {
        if (!isVisible(el)) return;
        const zRaw = el.style.zIndex || window.getComputedStyle(el).zIndex || '0';
        const z = parseInt(zRaw, 10);
        if (z > maxZ) { maxZ = z; top = el; }
    });
    return top;
}

function isStaticManaged(el: HTMLElement): boolean {
    return !!el && !!el.id && STATIC_IDS.indexOf(el.id) !== -1;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
function getFocusables(modal: HTMLElement): HTMLElement[] {
    const nodes = modal.querySelectorAll<HTMLElement>(FOCUSABLE);
    const out: HTMLElement[] = [];
    nodes.forEach(n => {
        if (n.offsetParent === null) return;
        if (n.closest && n.closest('[aria-hidden="true"]')) return;
        out.push(n);
    });
    return out;
}

let currentModal: HTMLElement | null = null; // 当前接管的最顶层弹窗
let restoreEl: Element | null = null;       // 打开前最后聚焦的元素

function focusFirst(modal: HTMLElement): void {
    const closeBtn = modal.querySelector<HTMLElement>('.modal-close-btn');
    if (closeBtn) { closeBtn.focus(); return; }
    const f = getFocusables(modal);
    if (f.length) f[0].focus();
}

// 状态同步：检测打开 / 关闭
function sync(): void {
    const top = getTopModal();
    if (top && top !== currentModal) {
        restoreEl = document.activeElement;
        currentModal = top;
        if (isStaticManaged(top)) {
            requestAnimationFrame(() => focusFirst(top));
        }
        return;
    }
    if (!top && currentModal) {
        const back = restoreEl as HTMLElement | null;
        currentModal = null;
        restoreEl = null;
        if (back && typeof back.focus === 'function' && back.isConnected) {
            try { back.focus(); } catch { /* ignore */ }
        }
    }
}

// Tab / Shift+Tab 焦点陷阱（捕获阶段，先于业务逻辑）
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const top = getTopModal();
    if (!top) return;
    const list = getFocusables(top);
    if (!list.length) { e.preventDefault(); return; }
    const active = document.activeElement as HTMLElement;
    const idx = list.indexOf(active);
    if (idx === -1) {
        e.preventDefault();
        list[0].focus();
        return;
    }
    if (e.shiftKey && idx === 0) {
        e.preventDefault();
        list[list.length - 1].focus();
    } else if (!e.shiftKey && idx === list.length - 1) {
        e.preventDefault();
        list[0].focus();
    }
}, true);

// Esc 关闭：仅对静态接管弹窗，点击其已有的 .modal-close-btn。
// stopImmediatePropagation 阻止 global.ts initModalEscKey 的通用 closeModal 重复触发。
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const top = getTopModal();
    if (!top) return;
    if (top.classList.contains('custom-prompt-modal')) return; // 自带 Esc 处理
    if (!isStaticManaged(top)) return;
    const closeBtn = top.querySelector<HTMLElement>('.modal-close-btn');
    if (!closeBtn) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    closeBtn.click();
}, true);

// 性能：弹窗内部高频 DOM 变动与「哪个弹窗最顶层」无关，不全树监听；
// 只监听 body 直接子节点增删（发现动态弹窗）+ 每个弹窗自身 style/class 变化。
let rafScheduled = false;
function scheduleSync(): void {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => { rafScheduled = false; sync(); });
}
let overlayObserver: MutationObserver | null = null;
function trackOverlay(el: HTMLElement): void {
    const tracked = el as HTMLElement & { __bpA11yTracked?: boolean };
    if (!el || tracked.__bpA11yTracked) return;
    tracked.__bpA11yTracked = true;
    if (overlayObserver) {
        try { overlayObserver.observe(el, { attributes: true, attributeFilter: ['style', 'class'] }); } catch { /* ignore */ }
    }
}
if (typeof MutationObserver !== 'undefined') {
    overlayObserver = new MutationObserver(scheduleSync);
    document.querySelectorAll<HTMLElement>('.modal-overlay').forEach(trackOverlay);
    const bodyObserver = new MutationObserver((mutations) => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === 1) {
                    const el = node as HTMLElement;
                    if (el.classList && el.classList.contains('modal-overlay')) trackOverlay(el);
                    if (el.querySelectorAll) {
                        el.querySelectorAll<HTMLElement>('.modal-overlay').forEach(trackOverlay);
                    }
                }
            });
        });
        scheduleSync();
    });
    bodyObserver.observe(document.body, { childList: true });
}
setInterval(scheduleSync, 1000); // 兜底轮询（observer 已覆盖，低频即可）
sync();
