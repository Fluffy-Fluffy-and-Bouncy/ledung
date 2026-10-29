// Light and dark mode for projectledung.com. Loaded in <head> so the page never flashes the wrong mode.
// Follows the visitor's system setting until they press the toggle; that choice is kept in localStorage.
(function () {
  const KEY = 'projectledung-mode';
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const read = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const write = (v) => { try { localStorage.setItem(KEY, v); } catch { /* file:// in some browsers: the choice lasts this visit */ } };
  let chosen = read();
  // ?mode=light|dark forces a mode without storing it (used for the screenshots).
  const forced = new URLSearchParams(location.search).get('mode');
  const mode = () => forced || chosen || (system.matches ? 'dark' : 'light');
  let button = null;

  function apply() {
    const m = mode();
    root.dataset.mode = m;
    root.style.colorScheme = m;
    if (button) {
      const next = m === 'dark' ? 'light' : 'dark';
      button.setAttribute('aria-label', `Switch to ${next} mode`);
      button.title = `Switch to ${next} mode`;
      button.innerHTML = m === 'dark'
        // A sun: pressing it brings the light.
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>'
        // A moon: pressing it brings the night.
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z"/></svg>';
    }
  }
  apply();
  system.addEventListener('change', apply);

  const css = `
  .mode-toggle { width: 34px; height: 34px; border-radius: 50%; border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    background: transparent; color: inherit; display: inline-grid; place-items: center; cursor: pointer; padding: 0; flex: none; opacity: .75; }
  .mode-toggle:hover { opacity: 1; }
  .mode-toggle:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; opacity: 1; }
  .mode-toggle svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .mode-toggle.floating { position: fixed; right: 16px; bottom: 16px; z-index: 60; }`;

  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'mode-toggle';
    button.addEventListener('click', () => {
      chosen = mode() === 'dark' ? 'light' : 'dark';
      write(chosen);
      apply();
    });
    const slot = document.querySelector('[data-mode-slot]');
    if (slot) slot.replaceWith(button);
    else { button.classList.add('floating'); document.body.appendChild(button); }
    apply();
  });
})();
