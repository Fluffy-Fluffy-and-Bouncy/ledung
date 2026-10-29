// The simulated install: types the npm commands into any <div data-term>, shows the output and a live ship,
// waits, then starts over. Nothing is published yet; the pages say so beside it.
(function () {
  const SCRIPT = [
    { cmd: 'npm install -g ledung' },
    { out: 'added 1 package, and audited 143 packages in 7s', dim: true },
    { out: 'found 0 vulnerabilities', dim: true },
    { cmd: 'ledung' },
    { out: 'Ledung is running at http://127.0.0.1:4317' },
    { out: 'Opening your browser… signed in.', dim: true },
    { ship: true },
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function run(el) {
    const prompt = el.dataset.prompt || '$';
    for (;;) {
      el.innerHTML = '';
      for (const step of SCRIPT) {
        const line = document.createElement('div');
        line.className = 'term-line';
        el.appendChild(line);
        if (step.cmd) {
          line.innerHTML = `<span class="term-prompt">${prompt}</span> <span class="term-cmd"></span><span class="term-caret">▍</span>`;
          const cmd = line.querySelector('.term-cmd');
          await sleep(500);
          for (const ch of step.cmd) { cmd.textContent += ch; await sleep(45 + Math.random() * 50); }
          await sleep(350);
          line.querySelector('.term-caret').remove();
        } else if (step.ship) {
          line.innerHTML = `<pre class="term-ship" data-ship="voyage" data-width="${el.dataset.shipWidth || 34}"></pre>`;
          window.LedungShip && window.LedungShip.init(line);
        } else {
          await sleep(step.dim ? 380 : 650);
          line.textContent = step.out;
          if (step.dim) line.classList.add('term-dim');
        }
      }
      const caret = document.createElement('div');
      caret.className = 'term-line';
      caret.innerHTML = `<span class="term-prompt">${prompt}</span> <span class="term-caret">▍</span>`;
      el.appendChild(caret);
      await sleep(14000);
    }
  }
  document.addEventListener('DOMContentLoaded', () => document.querySelectorAll('[data-term]').forEach(run));
})();
