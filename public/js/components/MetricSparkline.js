export class MetricSparkline extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() {
    return ['values', 'label'];
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.render();
    }
  }

  render() {
    const valuesStr = this.getAttribute('values') || '';
    const label = this.getAttribute('label') || '';
    const values = valuesStr.split(',').map(n => parseFloat(n)).filter(n => !isNaN(n));
    
    if (values.length === 0) {
      this.shadowRoot.innerHTML = '';
      return;
    }

    const width = 120;
    const height = 32;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    
    const points = values.map((val, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((val - min) / range) * (height - 4) - 2;
      return `${x},${y}`;
    }).join(' ');

    const fillPoints = `0,${height} ${points} ${width},${height}`;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          width: var(--sparkline-width, 120px);
        }
        svg {
          width: 100%;
          height: var(--sparkline-height, 32px);
        }
        polyline {
          fill: none;
          stroke: var(--sparkline-color, #2196F3);
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }
        polygon {
          fill: url(#grad);
          opacity: 0.2;
        }
        .label {
          font-size: 10px;
          color: #666;
          margin-top: 4px;
        }
      </style>
      <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--sparkline-color, #2196F3)"/>
            <stop offset="100%" stop-color="var(--sparkline-color, #2196F3)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <polygon points="${fillPoints}" />
        <polyline points="${points}" />
      </svg>
      ${label ? `<div class="label">${label}</div>` : ''}
    `;
  }
}

customElements.define('metric-sparkline', MetricSparkline);
