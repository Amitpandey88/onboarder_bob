export function initFlameGraph(canvas, options) {
  const { layers = [], files = [], facts = {} } = options || {};
  const ctx = canvas.getContext('2d');
  let width = canvas.width;
  let height = canvas.height;
  
  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    width = canvas.width;
    height = canvas.height;
    render();
  }

  function getRiskColor(risk) {
    if (risk <= 33) return 'rgb(76, 175, 80)';
    if (risk <= 66) return 'rgb(255, 193, 7)';
    return 'rgb(244, 67, 54)';
  }

  let rects = [];
  let rootPath = null;
  let breadcrumb = [];

  function update() {
    render();
  }

  function render() {
    ctx.clearRect(0, 0, width, height);
    if (!layers || layers.length === 0) return;

    rects = [];
    const layerH = 30;
    const pad = 2;

    // A real flame graph needs hierarchical data. If layers is just a list of arrays,
    // we'll lay them out horizontally per layer for now.
    
    let y = height - layerH;
    
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      let x = 0;
      let totalWeight = layer.length; // simplified
      
      for (const item of layer) {
        const w = (1 / totalWeight) * width;
        const risk = 0; // Find risk from facts if available
        
        ctx.fillStyle = getRiskColor(risk);
        ctx.fillRect(x + pad, y + pad, w - pad*2, layerH - pad*2);
        
        ctx.fillStyle = '#fff';
        ctx.font = '10px sans-serif';
        const txt = String(item).split('/').pop();
        if (w > 20) ctx.fillText(txt, x + pad + 2, y + 18);
        
        rects.push({ x, y, w, h: layerH, path: item });
        x += w;
      }
      y -= layerH;
    }
  }

  window.addEventListener('resize', resize);
  resize();

  return {
    update,
    resize,
    destroy: () => window.removeEventListener('resize', resize)
  };
}
