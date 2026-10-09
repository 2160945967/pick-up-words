// 键盘可访问性增强：让 <div> 伪装的按钮（汉堡菜单、折叠面板）支持 Enter/Space 触发

function isBtn(el: Element | null): el is HTMLElement {
    return !!el && (el.id === 'navbar-toggle' ||
        (el.classList != null && el.classList.contains('history-collapse-header')));
}

document.addEventListener('keydown', (e) => {
    const t = e.target as Element | null;
    if (!isBtn(t)) return;
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        t.click();
    }
});

// 折叠面板点击后同步 aria-expanded（依据下一兄弟节点的 display，与 modules/quiz 的 toggle 逻辑一致）
document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    const hdr = t && t.closest ? t.closest<HTMLElement>('.history-collapse-header') : null;
    if (!hdr) return;
    const body = hdr.nextElementSibling as HTMLElement | null;
    const open = !!(body && body.style && body.style.display !== 'none');
    hdr.setAttribute('aria-expanded', open ? 'true' : 'false');
});
