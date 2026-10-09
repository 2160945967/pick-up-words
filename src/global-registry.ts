type Fn = (...args: unknown[]) => void;

interface Registry {
    jumpToWord: Fn;
    navigateToWord: Fn;
    playPronunciation: Fn;
    playSentencePronunciation: Fn;
    switchPage: Fn;
    searchWord: Fn;
    translateText: Fn;
    showSearchHistory: Fn;
    selectSuggestion: Fn | null;
    removeFromFavorites: Fn;
    setFavoritesFilter: Fn;
    setFavoritesSort: Fn;
    removeFromErrorbook: Fn;
    setErrorbookFilter: Fn;
    setErrorbookSort: Fn;
    setWordbookFilter: Fn;
    setWordbookSort: Fn;
    removeFromWordlist: Fn;
    showImportFormat: Fn;
    removeFromSearchHistory: Fn | null;
    toggleHistoryDay: Fn;
    toggleDueWords: Fn;
    showDueWordsCondition: Fn;
    removeDueWord: Fn;
    toggleHistoryPanel: Fn;
}

const registry: Partial<Registry> = {};

export function setupGlobalRegistry(functions: Partial<Registry>): void {
    Object.assign(registry, functions);
}

export function getRegistry(): Partial<Registry> {
    return registry;
}

(window as unknown as Record<string, unknown>).g = function(name: string, ...args: unknown[]): void {
    const fn = registry[name as keyof Registry];
    if (typeof fn === 'function') {
        fn(...args);
    } else {
        console.warn(`[global-registry] 函数 ${name} 未注册`);
    }
};

// ===== 事件委托：以 [data-action] 替代内联 onclick，收敛 CSP =====

function datasetArgs(action: string, el: HTMLElement): unknown[] {
    const ds = el.dataset;
    if (action === 'playPronunciation') {
        return [ds.pron ?? ds.pronType ?? '', ds.word ?? ''];
    }
    if (action === 'playSentencePronunciation') return [ds.word ?? ''];
    if (action === 'toggleHistoryDay' || action === 'toggleDueWords' || action === 'toggleHistoryPanel') return [el];
    return [ds.word ?? ds.arg ?? ''];
}

let delegationStarted = false;

/** 在 document 捕获阶段统一处理 [data-action]；带 data-stop 的元素会阻止继续向下传递 */
export function initActionDelegation(): void {
    if (delegationStarted) return;
    delegationStarted = true;
    document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null;
        const el = target && typeof target.closest === 'function'
            ? target.closest('[data-action]') as HTMLElement | null
            : null;
        if (!el) return;
        const action = el.dataset.action as keyof Registry;
        const fn = registry[action];
        if (typeof fn !== 'function') return;
        if (el.dataset.stop !== undefined) e.stopPropagation();
        fn(...datasetArgs(action, el));
    }, true);
}
