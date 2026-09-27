// Mermaid rendering plus the canvas furniture: click wiring, pan & zoom,
// fit-to-view, SVG export. Mermaid comes from the vendored UMD build and
// stays a global; everything interactive happens here.

let initialized = false;
let renderSeq = 0;

function ensureMermaid() {
  if (initialized) return;
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose', // labels are escaped upstream; local tool, local data
    flowchart: { htmlLabels: false },
  });
  initialized = true;
}

export async function renderInto(contentEl, source) {
  ensureMermaid();
  const { svg } = await window.mermaid.render('obd' + ++renderSeq, source);
  contentEl.innerHTML = svg;
  const el = contentEl.querySelector('svg');
  // Mermaid emits `max-width` + fluid sizing, so the CSS box rarely matches
  // the viewBox units — and our pan/zoom math assumes 1 unit = 1 px. Pin the
  // box to the viewBox, or fit() sizes and centers against a phantom.
  if (el && el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal.width) {
    const vb = el.viewBox.baseVal;
    el.setAttribute('width', String(vb.width));
    el.setAttribute('height', String(vb.height));
    el.style.maxWidth = 'none';
    el.style.width = `${vb.width}px`;
    el.style.height = `${vb.height}px`;
  }
  return el;
}

// Mermaid gives every node a DOM id like "flowchart-f3-87"; the middle part
// is the id our diagram builders assigned, and `nodes` maps it back to a
// file or folder payload.
export function wireNodeClicks(contentEl, nodes, onClick) {
  for (const g of contentEl.querySelectorAll('g.node')) {
    const m = (g.id || '').match(/^flowchart-([A-Za-z0-9]+)-\d+$/);
    if (!m || !nodes[m[1]]) continue;
    g.style.cursor = 'pointer';
    g.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick(nodes[m[1]]);
    });
  }
}

export function makePanzoom(canvas, content) {
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const apply = () => {
    content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (content.classList.contains('atlas-mode')) return; // the atlas list takes its own clicks
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.classList.add('is-dragging');
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    tx += event.clientX - lastX;
    ty += event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    apply();
  });
  const stop = () => {
    dragging = false;
    canvas.classList.remove('is-dragging');
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  canvas.addEventListener('wheel', (event) => {
    if (content.classList.contains('atlas-mode')) return; // the atlas list scrolls
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    const next = Math.min(4, Math.max(0.12, scale * factor));
    tx = cx - ((cx - tx) * next) / scale;
    ty = cy - ((cy - ty) * next) / scale;
    scale = next;
    apply();
  }, { passive: false });

  canvas.addEventListener('dblclick', () => fit());

  function fit() {
    const first = content.firstElementChild;
    if (!first) return;
    let w = 0;
    let h = 0;
    if (first instanceof SVGElement) {
      try {
        const box = first.getBBox();
        w = box.width;
        h = box.height;
      } catch {
        return;
      }
    } else {
      // HTML content (the tree map): offset sizes ignore the transform.
      w = first.offsetWidth;
      h = first.offsetHeight;
    }
    if (!w || !h) return;
    const cw = canvas.clientWidth - 48;
    const ch = canvas.clientHeight - 48;
    scale = Math.min(cw / w, ch / h, 1.15);
    tx = (canvas.clientWidth - w * scale) / 2;
    ty = (canvas.clientHeight - h * scale) / 2;
    apply();
  }

  // Back to the un-zoomed, un-panned resting position (the atlas list wants
  // this — it is a document, not a diagram).
  function home() {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  }

  return { fit, reset: fit, home };
}

export function downloadSvg(contentEl, name) {
  const svg = contentEl.querySelector('svg');
  if (!svg) return false;
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const blob = new Blob(['<?xml version="1.0"?>\n' + clone.outerHTML], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}
