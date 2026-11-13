// Presentation-only web components. Controls stay in light DOM so labels,
// localization, native keyboard behavior and existing controllers keep working.
(() => {
  class AtShell extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = `
        <style>
          :host {
            display: block;
            box-sizing: border-box;
            max-width: 720px;
            margin: 0 auto;
            padding: 32px 24px 48px;
          }
          :host([compact]) { max-width: none; padding: 16px; }
          :host([hidden]) { display: none; }
          @media (max-width: 480px) {
            :host { padding: 20px 16px 32px; }
          }
        </style>
        <slot></slot>`;
    }
  }

  class AtPanel extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' }).innerHTML = `
        <style>
          :host { display: block; margin-block: 0 16px; min-width: 0; }
          :host([hidden]) { display: none; }
          section {
            padding: 20px;
            border: 1px solid var(--border);
            border-radius: var(--radius);
            background: var(--panel);
            color: var(--fg);
          }
          :host([compact]) section { padding: 14px; }
          @media (max-width: 480px) { section { padding: 16px; } }
        </style>
        <section><slot></slot></section>`;
    }
  }

  customElements.define('at-shell', AtShell);
  customElements.define('at-panel', AtPanel);
})();
