export class FileChip extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() {
    return ['path', 'lang', 'risk'];
  }

  connectedCallback() {
    this.render();
    this.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('file-select', {
        detail: { path: this.getAttribute('path') },
        bubbles: true,
        composed: true
      }));
    });
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.render();
    }
  }

  getRiskColor(risk) {
    const score = parseInt(risk, 10) || 0;
    if (score <= 33) return 'rgb(76, 175, 80)';
    if (score <= 66) return 'rgb(255, 193, 7)';
    return 'rgb(244, 67, 54)';
  }

  render() {
    const path = this.getAttribute('path') || '';
    const lang = this.getAttribute('lang') || 'txt';
    const risk = this.getAttribute('risk') || '0';
    
    const basename = path.split('/').pop();
    const riskColor = this.getRiskColor(risk);
    
    // Hash for lang color
    let hash = 0;
    for (let i = 0; i < lang.length; i++) hash = lang.charCodeAt(i) + ((hash << 5) - hash);
    const langHue = Math.abs(hash) % 360;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          padding: 4px 8px;
          border-radius: 16px;
          background: rgba(128, 128, 128, 0.1);
          border: 1px solid rgba(128, 128, 128, 0.2);
          cursor: pointer;
          font-family: sans-serif;
          font-size: 12px;
          transition: background 0.2s;
        }
        :host(:hover) {
          background: rgba(128, 128, 128, 0.2);
        }
        .lang-icon {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: hsl(${langHue}, 70%, 50%);
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 8px;
          font-weight: bold;
          margin-right: 6px;
          text-transform: uppercase;
        }
        .name {
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 150px;
        }
        .risk-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: ${riskColor};
          margin-left: 6px;
        }
      </style>
      <div class="lang-icon" title="${lang}">${lang.substring(0, 2)}</div>
      <div class="name" title="${path}">${basename}</div>
      <div class="risk-dot" title="Risk: ${risk}"></div>
    `;
    this.title = path;
  }
}

customElements.define('file-chip', FileChip);
