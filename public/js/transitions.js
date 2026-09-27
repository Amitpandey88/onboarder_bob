export function withTransition(callback) {
  if (document.startViewTransition) {
    document.startViewTransition(callback);
  } else {
    callback();
  }
}

export function setupViewTransitionNames(elements) {
  // Utility for adding transition names if needed
  Object.entries(elements).forEach(([id, name]) => {
    const el = document.getElementById(id);
    if (el) el.style.viewTransitionName = name;
  });
}
