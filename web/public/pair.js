// The Pair form's button (issue #466): once pressed it greys and says "Pairing…" until the answer comes. Through the
// relay that answer can take a few seconds, and a second press meanwhile cut the first one's answer off, cookie and
// all, so the first press looked like nothing and the second said the link was used. Without this script the form
// still works; the server then handles a second press itself.
const form = document.querySelector('form[method="post"][action="/pair"]');
if (form) {
  form.addEventListener('submit', (e) => {
    const button = form.querySelector('button');
    if (form.dataset.sent) {
      e.preventDefault();
      return;
    }
    form.dataset.sent = '1';
    if (button) {
      button.textContent = 'Pairing…';
      button.setAttribute('aria-disabled', 'true');
      button.style.opacity = '0.6';
    }
    const wait = document.getElementById('pair-wait');
    if (wait) wait.hidden = false;
  });
  // Back to this page from the browser's history: the form may be sent again.
  const label = form.querySelector('button')?.textContent ?? 'Pair';
  window.addEventListener('pageshow', () => {
    delete form.dataset.sent;
    const button = form.querySelector('button');
    if (button) {
      button.textContent = label;
      button.removeAttribute('aria-disabled');
      button.style.opacity = '';
    }
    const wait = document.getElementById('pair-wait');
    if (wait) wait.hidden = true;
  });
}
