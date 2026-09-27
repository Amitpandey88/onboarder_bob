// High-performance, interactive force-directed graph canvas engine.
// Implements Barnes-Hut physics, neighbor subgraph highlighting,
// theme-aware crisp text rendering, and rich interactive controls.

export function initForceGraph(canvas, options) {
  const opts = options || {};
  const ctx = canvas.getContext('2d');
  
  let animationFrameId = null;
  let nodes = [];
  let edges = [];
  let communities = {};
  
  let transform = { x: 0, y: 0, k: 1 };
  let width = canvas.width;
  let height = canvas.height;
  
  let alpha = 1.0;
  const alphaDecay = 0.985;
  const alphaMin = 0.001;
  
  let draggedNode = null;
  let hoveredNode = null;
  let selectedNode = null;
  let highlightPath = null;
  let searchQuery = '';
  let compactLabels = new Set();
  
  // Adjacency maps for fast interactive neighbor highlighting
  let inNeighbors = new Map();  // node -> Set of source nodes
  let outNeighbors = new Map(); // node -> Set of target nodes
  let nodeEdges = new Map();    // node -> Set of edges

  function resize() {
    const parent = canvas.parentElement;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);
    
    width = rect.width;
    height = rect.height;
    
    if (nodes.length > 0 && transform.k === 1 && transform.x === 0 && transform.y === 0) {
      fitToScreen();
    } else {
      render();
    }
  }

  // Quadtree spatial index for Barnes-Hut O(N log N) repulsion
  class QuadTree {
    constructor(x, y, w, h) {
      this.x = x;
      this.y = y;
      this.w = w;
      this.h = h;
      this.nodes = [];
      this.mass = 0;
      this.cx = 0;
      this.cy = 0;
      this.children = null;
    }
    
    insert(node) {
      if (this.children) {
        const i = (node.x > this.x + this.w / 2 ? 1 : 0) + (node.y > this.y + this.h / 2 ? 2 : 0);
        this.children[i].insert(node);
      } else {
        this.nodes.push(node);
        if (this.nodes.length > 1 && this.w > 4) {
          this.subdivide();
        }
      }
      this.mass += 1;
      this.cx = (this.cx * (this.mass - 1) + node.x) / this.mass;
      this.cy = (this.cy * (this.mass - 1) + node.y) / this.mass;
    }
    
    subdivide() {
      const hw = this.w / 2;
      const hh = this.h / 2;
      this.children = [
        new QuadTree(this.x, this.y, hw, hh),
        new QuadTree(this.x + hw, this.y, hw, hh),
        new QuadTree(this.x, this.y + hh, hw, hh),
        new QuadTree(this.x + hw, this.y + hh, hw, hh)
      ];
      const oldNodes = this.nodes;
      this.nodes = [];
      for (const n of oldNodes) {
        const i = (n.x > this.x + hw ? 1 : 0) + (n.y > this.y + hh ? 2 : 0);
        this.children[i].insert(n);
      }
    }
    
    applyForce(node, theta = 0.85) {
      if (this.mass === 0) return;
      const dx = this.cx - node.x;
      const dy = this.cy - node.y;
      const distSq = dx * dx + dy * dy;
      
      if (this.w / Math.sqrt(distSq || 1) < theta || !this.children) {
        if (distSq > 0.01) {
          const dist = Math.sqrt(distSq);
          // Scale repulsion force inversely proportional to distance
          const f = -120 * this.mass / (distSq + 100);
          node.vx += (dx / dist) * f;
          node.vy += (dy / dist) * f;
        }
      } else {
        for (const child of this.children) {
          child.applyForce(node, theta);
        }
      }
    }
  }

  function buildAdjacency() {
    inNeighbors = new Map();
    outNeighbors = new Map();
    nodeEdges = new Map();
    
    for (const n of nodes) {
      inNeighbors.set(n, new Set());
      outNeighbors.set(n, new Set());
      nodeEdges.set(n, new Set());
    }
    
    for (const e of edges) {
      if (e.source && e.target) {
        outNeighbors.get(e.source)?.add(e.target);
        inNeighbors.get(e.target)?.add(e.source);
        nodeEdges.get(e.source)?.add(e);
        nodeEdges.get(e.target)?.add(e);
      }
    }
  }

  function update(newNodes, newEdges, newComms) {
    communities = newComms || {};
    
    const posMap = new Map(nodes.map(n => [n.path, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }]));
    
    nodes = newNodes.map((n, i) => {
      const p = posMap.get(n.path);
      const angle = (i / Math.max(1, newNodes.length)) * Math.PI * 2;
      const dist = Math.min(width, height) * 0.35;
      return {
        ...n,
        x: p ? p.x : Math.cos(angle) * dist + (Math.random() - 0.5) * 40,
        y: p ? p.y : Math.sin(angle) * dist + (Math.random() - 0.5) * 40,
        vx: p ? p.vx : 0,
        vy: p ? p.vy : 0,
        r: Math.max(5, Math.min(24, 4 + Math.sqrt(n.fanIn || 0) * 2.5)),
        basename: n.path.split('/').pop() || n.path
      };
    });
    compactLabels = new Set([...nodes]
      .sort((a, b) => b.fanIn - a.fanIn)
      .slice(0, 8)
      .map((node) => node.path));
    
    const nodeByPath = new Map(nodes.map(n => [n.path, n]));
    edges = (newEdges || []).map(e => ({
      source: nodeByPath.get(e.from),
      target: nodeByPath.get(e.to),
      from: e.from,
      to: e.to
    })).filter(e => e.source && e.target);
    
    buildAdjacency();
    
    alpha = 1.0;
    if (!animationFrameId) tick();
  }

  function tick() {
    if (alpha > alphaMin) {
      alpha *= alphaDecay;
      
      // Repulsion via Quadtree
      if (nodes.length > 0) {
        let minX = nodes[0].x, maxX = nodes[0].x;
        let minY = nodes[0].y, maxY = nodes[0].y;
        for (const n of nodes) {
          if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
          if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
        }
        const span = Math.max(maxX - minX, maxY - minY, 100);
        const qt = new QuadTree(minX - 20, minY - 20, span + 40, span + 40);
        for (const n of nodes) qt.insert(n);
        for (const n of nodes) qt.applyForce(n);
      }
      
      // Hooke's Law Edge Springs
      for (const e of edges) {
        const dx = e.target.x - e.source.x;
        const dy = e.target.y - e.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetDist = 45 + (e.source.r + e.target.r) * 1.5;
        const f = (dist - targetDist) * 0.04 * alpha;
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        e.source.vx += fx; e.source.vy += fy;
        e.target.vx -= fx; e.target.vy -= fy;
      }
      
      // Center Gravity
      for (const n of nodes) {
        n.vx -= n.x * 0.015 * alpha;
        n.vy -= n.y * 0.015 * alpha;
      }
      
      // Velocity Verlet update
      for (const n of nodes) {
        if (n !== draggedNode) {
          n.vx *= 0.65;
          n.vy *= 0.65;
          n.x += n.vx;
          n.y += n.vy;
        }
      }
    }
    
    render();
    
    if (alpha > alphaMin || draggedNode) {
      animationFrameId = requestAnimationFrame(tick);
    } else {
      animationFrameId = null;
    }
  }

  function reheat() {
    alpha = 0.5;
    if (!animationFrameId) tick();
  }

  function isDarkTheme() {
    return document.documentElement.dataset.theme === 'dark';
  }

  function render() {
    ctx.save();
    ctx.clearRect(0, 0, width, height);
    
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);
    
    const dark = isDarkTheme();
    const activeNode = hoveredNode || selectedNode;
    const hasFocus = Boolean(activeNode || highlightPath || searchQuery);
    
    const inSet = activeNode ? inNeighbors.get(activeNode) : null;
    const outSet = activeNode ? outNeighbors.get(activeNode) : null;
    
    // Draw Edges
    for (const e of edges) {
      const isOut = activeNode && e.source === activeNode;
      const isIn = activeNode && e.target === activeNode;
      const isConnected = isOut || isIn;
      
      ctx.beginPath();
      ctx.moveTo(e.source.x, e.source.y);
      ctx.lineTo(e.target.x, e.target.y);
      
      if (isConnected) {
        ctx.strokeStyle = isOut ? '#f43f5e' : '#38bdf8'; // Outbound (rose) vs Inbound (cyan)
        ctx.lineWidth = 2.4 / transform.k;
        ctx.globalAlpha = 0.95;
      } else {
        ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(30, 41, 59, 0.22)';
        ctx.lineWidth = 1 / transform.k;
        ctx.globalAlpha = hasFocus ? 0.04 : 0.45;
      }
      ctx.stroke();
    }
    
    // Draw Nodes
    for (const n of nodes) {
      const isTarget = n === activeNode;
      const isNeighbor = activeNode && (inSet?.has(n) || outSet?.has(n));
      const isPathMatch = highlightPath && n.path === highlightPath;
      const isSearchMatch = searchQuery && n.path.toLowerCase().includes(searchQuery.toLowerCase());
      const isHighlighted = isTarget || isNeighbor || isPathMatch || isSearchMatch;
      
      const nodeAlpha = hasFocus ? (isHighlighted ? 1.0 : 0.18) : 0.92;
      ctx.globalAlpha = nodeAlpha;
      
      // Node circle fill
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
      
      const hue = n.community ? (n.community * 137.5) % 360 : ((n.fanIn * 37) % 360);
      ctx.fillStyle = `hsl(${hue}, 75%, ${dark ? '55%' : '45%'})`;
      ctx.fill();
      
      // Outer border / glow ring
      if (isHighlighted) {
        ctx.lineWidth = (isTarget ? 3.5 : 2) / transform.k;
        ctx.strokeStyle = isTarget ? (dark ? '#ffffff' : '#0f172a') : (inSet?.has(n) ? '#38bdf8' : '#f43f5e');
        ctx.stroke();
      } else {
        ctx.lineWidth = 1 / transform.k;
        ctx.strokeStyle = dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.2)';
        ctx.stroke();
      }
    }
    
    // Draw Crisp Theme-Aware Text Labels (with dark/light halo outline)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    
    for (const n of nodes) {
      const isTarget = n === activeNode;
      const isNeighbor = activeNode && (inSet?.has(n) || outSet?.has(n));
      const isPathMatch = highlightPath && n.path === highlightPath;
      const isSearchMatch = searchQuery && n.path.toLowerCase().includes(searchQuery.toLowerCase());
      const shouldShowLabel = width < 600
        ? isTarget || isNeighbor || isPathMatch || isSearchMatch ||
          (compactLabels.has(n.path) && transform.k >= 0.4) || transform.k >= 1.8
        : isTarget || isNeighbor || isPathMatch || isSearchMatch ||
          (n.fanIn >= 2 && transform.k >= 0.4) || transform.k >= 1.1;
      
      if (!shouldShowLabel) continue;
      
      const isProminent = isTarget || isNeighbor || isPathMatch || isSearchMatch;
      ctx.globalAlpha = hasFocus ? (isProminent ? 1.0 : 0.15) : 0.95;
      
      const fontSize = Math.max(10, Math.min(14, 11 / Math.sqrt(transform.k)));
      ctx.font = `${isProminent ? '600' : '500'} ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace`;
      
      const textX = n.x + n.r + 4 / transform.k;
      const textY = n.y;
      const label = n.basename;
      
      // Stroke halo background for contrast against any background
      ctx.lineWidth = 3.5 / transform.k;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = dark ? 'rgba(10, 14, 23, 0.92)' : 'rgba(255, 255, 255, 0.95)';
      ctx.strokeText(label, textX, textY);
      
      // Bright / High-contrast foreground text
      if (isTarget) {
        ctx.fillStyle = dark ? '#38bdf8' : '#0284c7';
      } else if (isProminent) {
        ctx.fillStyle = dark ? '#f8fafc' : '#0f172a';
      } else {
        ctx.fillStyle = dark ? '#cbd5e1' : '#334155';
      }
      ctx.fillText(label, textX, textY);
    }
    
    ctx.restore();
  }

  function fitToScreen() {
    if (nodes.length === 0) {
      transform = { x: width / 2, y: height / 2, k: 1 };
      render();
      return;
    }
    
    let minX = nodes[0].x, maxX = nodes[0].x;
    let minY = nodes[0].y, maxY = nodes[0].y;
    for (const n of nodes) {
      if (n.x - n.r < minX) minX = n.x - n.r;
      if (n.x + n.r > maxX) maxX = n.x + n.r;
      if (n.y - n.r < minY) minY = n.y - n.r;
      if (n.y + n.r > maxY) maxY = n.y + n.r;
    }
    
    const spanW = Math.max(40, maxX - minX);
    const spanH = Math.max(40, maxY - minY);
    const padding = 60;
    
    const k = Math.min(
      (width - padding * 2) / spanW,
      (height - padding * 2) / spanH,
      2.0
    );
    
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    
    transform.k = Math.max(0.2, k);
    transform.x = width / 2 - cx * transform.k;
    transform.y = height / 2 - cy * transform.k;
    
    render();
  }

  function resetLayout() {
    const dist = Math.min(width, height) * 0.35;
    nodes.forEach((n, i) => {
      const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
      n.x = Math.cos(angle) * dist + (Math.random() - 0.5) * 30;
      n.y = Math.sin(angle) * dist + (Math.random() - 0.5) * 30;
      n.vx = 0;
      n.vy = 0;
    });
    fitToScreen();
    alpha = 1.0;
    if (!animationFrameId) tick();
  }

  function flyToNode(node) {
    if (!node) return;
    const targetK = Math.max(1.2, transform.k);
    transform.k = targetK;
    transform.x = width / 2 - node.x * targetK;
    transform.y = height / 2 - node.y * targetK;
    selectedNode = node;
    render();
  }

  function updateTooltip(node, clientX, clientY) {
    const tooltip = document.getElementById('graphTooltip');
    if (!tooltip) return;
    
    if (!node) {
      tooltip.hidden = true;
      return;
    }
    
    const inCount = inNeighbors.get(node)?.size || node.fanIn || 0;
    const outCount = outNeighbors.get(node)?.size || node.fanOut || 0;
    
    tooltip.innerHTML = `
      <div style="font-weight:600; font-size:13px; margin-bottom:4px; display:flex; align-items:center; gap:6px;">
        <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:hsl(${(node.community * 137.5) % 360}, 75%, 50%);"></span>
        ${node.basename}
      </div>
      <div style="font-size:11px; color:var(--faint); margin-bottom:8px; word-break:break-all;">${node.path}</div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; font-size:11px;">
        <span class="role-chip" style="background:var(--accent-soft); color:var(--accent);"><b>${inCount}</b> dependents</span>
        <span class="role-chip" style="background:var(--card);"><b>${outCount}</b> imports</span>
        ${node.risk ? `<span class="role-chip is-cycle">risk <b>${node.risk}</b></span>` : ''}
      </div>
      <div style="font-size:10px; color:var(--faint); margin-top:6px; font-style:italic;">Click to open · Double-click to center</div>
    `;
    
    tooltip.style.left = Math.min(clientX + 14, window.innerWidth - 260) + 'px';
    tooltip.style.top = Math.min(clientY + 14, window.innerHeight - 160) + 'px';
    tooltip.hidden = false;
  }

  // --- Interaction Event Handlers ---
  let isPanning = false;
  let startX = 0, startY = 0;
  let lastClickTime = 0;

  const nodeAt = e => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left - transform.x) / transform.k;
    const my = (e.clientY - rect.top - transform.y) / transform.k;
    return nodes.find(n => {
      const dx = n.x - mx;
      const dy = n.y - my;
      return Math.sqrt(dx * dx + dy * dy) <= (n.r + 4);
    });
  };

  canvas.addEventListener('pointerdown', e => {
    canvas.setPointerCapture(e.pointerId);
    draggedNode = nodeAt(e);
    if (draggedNode) {
      draggedNode.vx = 0;
      draggedNode.vy = 0;
      reheat();
    } else {
      isPanning = true;
      startX = e.clientX - transform.x;
      startY = e.clientY - transform.y;
    }
  });

  canvas.addEventListener('pointermove', e => {
    const rect = canvas.getBoundingClientRect();
    
    if (draggedNode) {
      draggedNode.x = (e.clientX - rect.left - transform.x) / transform.k;
      draggedNode.y = (e.clientY - rect.top - transform.y) / transform.k;
      draggedNode.vx = 0;
      draggedNode.vy = 0;
      updateTooltip(draggedNode, e.clientX, e.clientY);
      if (!animationFrameId) render();
    } else if (isPanning) {
      transform.x = e.clientX - startX;
      transform.y = e.clientY - startY;
      if (!animationFrameId) render();
    } else {
      const newHover = nodeAt(e);
      
      if (newHover !== hoveredNode) {
        hoveredNode = newHover || null;
        canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
        updateTooltip(hoveredNode, e.clientX, e.clientY);
        if (!animationFrameId) render();
      } else if (hoveredNode) {
        updateTooltip(hoveredNode, e.clientX, e.clientY);
      }
    }
  });

  const stopPointer = e => {
    draggedNode = null;
    isPanning = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerup', stopPointer);
  canvas.addEventListener('pointercancel', stopPointer);

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
    const newK = Math.max(0.1, Math.min(5.0, transform.k * zoomFactor));
    
    transform.x = mx - (mx - transform.x) * (newK / transform.k);
    transform.y = my - (my - transform.y) * (newK / transform.k);
    transform.k = newK;
    
    if (!animationFrameId) render();
  }, { passive: false });

  canvas.addEventListener('click', e => {
    const now = Date.now();
    const isDouble = now - lastClickTime < 300;
    lastClickTime = now;
    
    const clickedNode = nodeAt(e);
    if (clickedNode) {
      if (isDouble) {
        flyToNode(clickedNode);
      } else {
        selectedNode = clickedNode;
        canvas.dispatchEvent(new CustomEvent('graph-node-click', {
          detail: { path: clickedNode.path },
          bubbles: true
        }));
      }
    } else {
      selectedNode = null;
      if (!animationFrameId) render();
    }
  });

  canvas.addEventListener('mouseleave', () => {
    hoveredNode = null;
    updateTooltip(null);
    if (!animationFrameId) render();
  });

  // Wire Controls HUD
  const resetBtn = document.getElementById('graphReset');
  const zoomInBtn = document.getElementById('graphZoomIn');
  const zoomOutBtn = document.getElementById('graphZoomOut');
  
  if (resetBtn) resetBtn.onclick = () => resetLayout();
  if (zoomInBtn) zoomInBtn.onclick = () => {
    const newK = Math.min(5.0, transform.k * 1.25);
    transform.x = width / 2 - (width / 2 - transform.x) * (newK / transform.k);
    transform.y = height / 2 - (height / 2 - transform.y) * (newK / transform.k);
    transform.k = newK;
    if (!animationFrameId) render();
  };
  if (zoomOutBtn) zoomOutBtn.onclick = () => {
    const newK = Math.max(0.1, transform.k * 0.8);
    transform.x = width / 2 - (width / 2 - transform.x) * (newK / transform.k);
    transform.y = height / 2 - (height / 2 - transform.y) * (newK / transform.k);
    transform.k = newK;
    if (!animationFrameId) render();
  };

  window.addEventListener('resize', resize);
  setTimeout(resize, 50);

  return {
    update,
    resize,
    fit: fitToScreen,
    reset: resetLayout,
    search: q => { searchQuery = q; if (!animationFrameId) render(); },
    highlight: path => { highlightPath = path; if (!animationFrameId) render(); },
    destroy: () => {
      window.removeEventListener('resize', resize);
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    }
  };
}
