// The install box: a copy button for the install command, and the version line read live from npm (#436).
(function () {
  const COMMAND = 'npm install -g ledung';

  // Copy only the install command, not the second line: selecting the box took both (#436).
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // No Clipboard API (an insecure origin, an old browser): the textarea way still works on a click.
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      area.remove();
      return ok;
    }
  }

  for (const button of document.querySelectorAll('[data-copy-install]')) {
    let timer = 0;
    button.addEventListener('click', async () => {
      const ok = await copy(COMMAND);
      button.textContent = ok ? 'Copied' : 'Copy failed';
      button.classList.toggle('done', ok);
      clearTimeout(timer);
      timer = setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('done'); }, 1800);
    });
  }

  // The version line: npm's `latest`, never `dev`, first number only ("Ledung v3 on npm" for 3.0.0;
  // Martin on #436: "I dont want the two zeroes, only the first number."). Read live so the page never
  // shows a stale number; when npm can't be reached the line keeps its plain "Ledung on npm".
  // This endpoint is the `latest` manifest and, unlike the dist-tags one, is served with CORS.
  const line = document.querySelector('[data-npm-version]');
  if (line && window.fetch) {
    fetch('https://registry.npmjs.org/ledung/latest', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((manifest) => {
        const major = String(manifest && manifest.version || '').match(/^(\d+)\.\d+\.\d+$/);
        if (major) line.textContent = `Ledung v${major[1]} on npm`;
      })
      .catch(() => { /* offline or blocked: keep "Ledung on npm" */ });
  }
})();
