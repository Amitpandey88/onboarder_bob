export class RiskBadge extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  static get observedAttributes() {
    return ['score'];
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'score' && oldValue !== newValue) {
      this.updateScore(parseInt(newValue, 10) || 0);
    }
  }

  getScoreColor(score) {
    if (score <= 33) return 'rgb(76, 175, 80)';
    if (score <= 66) return 'rgb(255, 193, 7)';
    return 'rgb(244, 67, 54)';
  }

  render() {
    const score = parseInt(this.getAttribute('score') || '0', 10);
    const size = 48;
    const strokeWidth = 4;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          position: relative;
          width: var(--risk-size, 48px);
          height: var(--risk-size, 48px);
        }
        svg {
          transform: rotate(-90deg);
          width: 100%;
          height: 100%;
        }
        .bg {
          fill: none;
          stroke: rgba(128, 128, 128, 0.2);
          stroke-width: ${strokeWidth};
        }
        .arc {
          fill: none;
          stroke: ${this.getScoreColor(score)};
          stroke-width: ${strokeWidth};
          stroke-linecap: round;
          stroke-dasharray: ${circumference};
          stroke-dashoffset: ${circumference};
        }
        .text {
          position: absolute;
          font-family: monospace;
          font-size: 14px;
          font-weight: bold;
        }
      </style>
      <svg viewBox="0 0 ${size} ${size}">
        <circle class="bg" cx="${size/2}" cy="${size/2}" r="${radius}" />
        <circle class="arc" cx="${size/2}" cy="${size/2}" r="${radius}" />
      </svg>
      <span class="text">${score}</span>
    `;
    this.updateScore(score);
  }

  updateScore(score) {
    if (!this.shadowRoot.querySelector('.arc')) return;
    
    const size = 48;
    const strokeWidth = 4;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (score / 100) * circumference;
    
    const arc = this.shadowRoot.querySelector('.arc');
    const text = this.shadowRoot.querySelector('.text');
    
    const color = this.getScoreColor(score);
    arc.style.stroke = color;
    text.textContent = score;

    arc.animate([
      { strokeDashoffset: circumference },
      { strokeDashoffset: offset }
    ], {
      duration: 1000,
      easing: 'ease-out',
      fill: 'forwards'
    });
  }
}

customElements.define('risk-badge', RiskBadge);
