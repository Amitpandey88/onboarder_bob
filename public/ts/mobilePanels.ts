export interface MobilePanels {
  close(): void;
}

type Panel = 'files' | 'details' | null;

/** Small screen file tree and inspector drawers, with one active panel at a time. */
export function initMobilePanels(): MobilePanels {
  const root = document.getElementById('explorer') as HTMLElement;
  const filesButton = document.getElementById('mobileFilesBtn') as HTMLButtonElement;
  const detailsButton = document.getElementById('mobileDetailsBtn') as HTMLButtonElement;
  const filesClose = document.getElementById('mobileFilesClose') as HTMLButtonElement;
  const detailsClose = document.getElementById('mobileDetailsClose') as HTMLButtonElement;
  const scrim = document.getElementById('mobilePanelScrim') as HTMLButtonElement;
  const fileTree = document.getElementById('fileTree') as HTMLElement;
  const fileSidebar = document.getElementById('fileSidebar') as HTMLElement;
  const inspector = document.getElementById('inspector') as HTMLElement;
  const viewTabs = document.getElementById('viewTabs') as HTMLElement;
  const smallScreen = window.matchMedia('(max-width: 900px)');
  let active: Panel = null;

  function show(panel: Panel): void {
    active = smallScreen.matches ? panel : null;
    root.dataset.mobilePanel = active ?? '';
    scrim.hidden = active === null;
    filesButton.setAttribute('aria-expanded', String(active === 'files'));
    detailsButton.setAttribute('aria-expanded', String(active === 'details'));
    if (active === 'files') fileSidebar.focus();
    if (active === 'details') inspector.focus();
  }

  function closeAndRestoreFocus(): void {
    const prior = active;
    show(null);
    if (prior) (prior === 'files' ? filesButton : detailsButton).focus();
  }

  filesButton.addEventListener('click', () => show(active === 'files' ? null : 'files'));
  detailsButton.addEventListener('click', () => show(active === 'details' ? null : 'details'));
  scrim.addEventListener('click', closeAndRestoreFocus);
  filesClose.addEventListener('click', closeAndRestoreFocus);
  detailsClose.addEventListener('click', closeAndRestoreFocus);
  fileTree.addEventListener('click', (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('.tree-file')) closeAndRestoreFocus();
  });
  viewTabs.addEventListener('click', () => show(null));
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && active) {
      closeAndRestoreFocus();
    }
  });
  smallScreen.addEventListener('change', () => show(null));

  return { close: () => show(null) };
}
