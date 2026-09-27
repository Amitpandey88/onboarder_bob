export function initHeatmap(canvas, files = []) {
  const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
  if (!gl) {
    console.warn('WebGL not supported, falling back to Canvas 2D (not implemented)');
    return { update: () => {}, destroy: () => {} };
  }

  const vsSource = `
    attribute vec2 aVertexPosition;
    attribute vec3 aColor;
    varying vec3 vColor;
    void main() {
      gl_Position = vec4(aVertexPosition, 0.0, 1.0);
      vColor = aColor;
    }
  `;

  const fsSource = `
    precision mediump float;
    varying vec3 vColor;
    void main() {
      gl_FragColor = vec4(vColor, 1.0);
    }
  `;

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);

  const positionLocation = gl.getAttribLocation(program, 'aVertexPosition');
  const colorLocation = gl.getAttribLocation(program, 'aColor');

  const positionBuffer = gl.createBuffer();
  const colorBuffer = gl.createBuffer();

  let fileRects = [];
  let cols, rows;

  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (files.length) update(files);
  }

  function getRiskColor(risk) {
    if (risk <= 33) return [76/255, 175/255, 80/255]; // Green
    if (risk <= 66) return [255/255, 193/255, 7/255]; // Yellow
    return [244/255, 67/255, 54/255]; // Red
  }

  function update(newFiles) {
    files = newFiles.sort((a, b) => a.path.localeCompare(b.path));
    const count = files.length;
    if (count === 0) return;

    cols = Math.ceil(Math.sqrt(count * (canvas.width / canvas.height)));
    rows = Math.ceil(count / cols);
    
    const tileW = 2.0 / cols;
    const tileH = 2.0 / rows;

    const positions = new Float32Array(count * 12);
    const colors = new Float32Array(count * 18);

    fileRects = [];

    for (let i = 0; i < count; i++) {
      const c = i % cols;
      const r = Math.floor(i / cols);
      
      const x = -1.0 + c * tileW;
      const y = 1.0 - r * tileH;
      
      const padX = tileW * 0.05;
      const padY = tileH * 0.05;
      
      const px1 = x + padX; const py1 = y - padY;
      const px2 = x + tileW - padX; const py2 = y - tileH + padY;

      fileRects.push({ file: files[i], x: px1, y: py1, w: px2-px1, h: py2-py1 });

      const pIdx = i * 12;
      positions.set([
        px1, py1, px2, py1, px1, py2,
        px1, py2, px2, py1, px2, py2
      ], pIdx);

      const color = getRiskColor(files[i].risk || 0);
      const cIdx = i * 18;
      for (let j = 0; j < 6; j++) {
        colors.set(color, cIdx + j * 3);
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);

    render(count);
  }

  function render(count) {
    gl.clearColor(0.1, 0.1, 0.1, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.enableVertexAttribArray(colorLocation);
    gl.vertexAttribPointer(colorLocation, 3, gl.FLOAT, false, 0, 0);

    gl.drawArrays(gl.TRIANGLES, 0, count * 6);
  }

  function fileAt(clientX, clientY) {
    if (fileRects.length === 0) return null;
    const rect = canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    for (const fr of fileRects) {
      if (nx >= fr.x && nx <= fr.x + fr.w && ny <= fr.y && ny >= fr.y + fr.h) {
        return fr.file;
      }
    }
    return null;
  }

  canvas.addEventListener('pointermove', e => {
    const hovered = fileAt(e.clientX, e.clientY);

    const tooltip = document.getElementById('heatmapTooltip');
    if (tooltip) {
      if (hovered) {
        tooltip.textContent = `${hovered.path} (Risk: ${hovered.risk || 0})`;
        tooltip.style.left = e.clientX + 10 + 'px';
        tooltip.style.top = e.clientY + 10 + 'px';
        tooltip.hidden = false;
      } else {
        tooltip.hidden = true;
      }
    }
  });

  canvas.addEventListener('pointerleave', () => {
    const tooltip = document.getElementById('heatmapTooltip');
    if (tooltip) tooltip.hidden = true;
  });

  canvas.addEventListener('click', e => {
    const file = fileAt(e.clientX, e.clientY);
    if (file) {
      canvas.dispatchEvent(new CustomEvent('heatmap-node-click', {
        detail: { path: file.path },
        bubbles: true
      }));
    }
  });

  window.addEventListener('resize', resize);
  resize();

  return {
    update,
    destroy: () => window.removeEventListener('resize', resize)
  };
}
