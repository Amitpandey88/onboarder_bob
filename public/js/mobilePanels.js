/** Small screen file tree and inspector drawers, with one active panel at a time. */
export function initMobilePanels() {
    const root = document.getElementById('explorer');
    const filesButton = document.getElementById('mobileFilesBtn');
    const detailsButton = document.getElementById('mobileDetailsBtn');
    const filesClose = document.getElementById('mobileFilesClose');
    const detailsClose = document.getElementById('mobileDetailsClose');
    const scrim = document.getElementById('mobilePanelScrim');
    const fileTree = document.getElementById('fileTree');
    const fileSidebar = document.getElementById('fileSidebar');
    const inspector = document.getElementById('inspector');
    const viewTabs = document.getElementById('viewTabs');
    const smallScreen = window.matchMedia('(max-width: 900px)');
    let active = null;
    function show(panel) {
        active = smallScreen.matches ? panel : null;
        root.dataset.mobilePanel = active ?? '';
        scrim.hidden = active === null;
        filesButton.setAttribute('aria-expanded', String(active === 'files'));
        detailsButton.setAttribute('aria-expanded', String(active === 'details'));
        if (active === 'files')
            fileSidebar.focus();
        if (active === 'details')
            inspector.focus();
    }
    function closeAndRestoreFocus() {
        const prior = active;
        show(null);
        if (prior)
            (prior === 'files' ? filesButton : detailsButton).focus();
    }
    filesButton.addEventListener('click', () => show(active === 'files' ? null : 'files'));
    detailsButton.addEventListener('click', () => show(active === 'details' ? null : 'details'));
    scrim.addEventListener('click', closeAndRestoreFocus);
    filesClose.addEventListener('click', closeAndRestoreFocus);
    detailsClose.addEventListener('click', closeAndRestoreFocus);
    fileTree.addEventListener('click', (event) => {
        if (event.target instanceof Element && event.target.closest('.tree-file'))
            closeAndRestoreFocus();
    });
    viewTabs.addEventListener('click', () => show(null));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && active) {
            closeAndRestoreFocus();
        }
    });
    smallScreen.addEventListener('change', () => show(null));
    return { close: () => show(null) };
}
