// The changelog pages (issue #417; Martin, 2026-11-19 14:18, Ledung question #606: "Both, online page reads the repo
// file"). Each page names its file in <main data-changelog="CHANGELOG.md">; this fetches it from the repository's main
// branch on GitHub when the page opens, so the page is current without uploading the site for every release, and draws
// it in the site's look. No CDN and no Markdown library (site/README.md): the files use a small part of Markdown
// (headings, `- ` bullets, paragraphs, `code`, **bold**, [links](…)), and that is all this reads. Everything is escaped
// before it becomes HTML.
(function () {
  const REPO = 'Fluffy-Fluffy-and-Bouncy/ledung';
  const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
  const BLOB = `https://github.com/${REPO}/blob/main/`;

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** A link target: http(s) as is, a path in the repository to its page on GitHub; anything else is not a link. */
  function href(url) {
    if (/^https?:\/\//i.test(url)) return url;
    if (/^[\w./#-]+$/.test(url) && !url.startsWith('/')) return BLOB + url.replace(/^\.\//, '');
    return null;
  }

  /** Inline Markdown on escaped text: `code` first, so nothing inside it is read as bold or a link. */
  function inline(text) {
    return text.split(/(`[^`]*`)/).map((part) => {
      if (/^`[^`]*`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
      let html = esc(part);
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label, url) => {
        const to = href(url.replace(/&amp;/g, '&'));
        return to ? `<a href="${esc(to)}">${label}</a>` : label;
      });
      // A bare address in the text, such as the page's own.
      html = html.replace(/(^|[\s(])(https:\/\/[^\s<)]+[^\s<).,])/g, '$1<a href="$2">$2</a>');
      return html;
    }).join('');
  }

  /**
   * The file from its first `## ` heading on (the header above it is for people editing the file). A release heading,
   * `## v3.10 — 2026-11-19 15:02 CET`, gets its version and time apart; a date heading of the earlier history is a
   * smaller heading under "Earlier, by date".
   */
  function render(markdown) {
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    const start = lines.findIndex((l) => l.startsWith('## '));
    if (start < 0) return '<p class="cl-note">This changelog has no releases yet.</p>';
    const out = [];
    let list = null;
    let para = null;
    const flush = () => {
      if (list) out.push(`<ul>${list.map((b) => `<li>${inline(b)}</li>`).join('')}</ul>`);
      if (para) out.push(`<p>${inline(para.join(' '))}</p>`);
      list = null;
      para = null;
    };
    let releases = 0;
    for (const line of lines.slice(start)) {
      const head = /^## (.*)$/.exec(line);
      if (head) {
        flush();
        const title = head[1].trim();
        const release = /^(v\d+(?:\.\d+)?)\s+[—-]\s+(.+)$/.exec(title);
        if (release) {
          releases++;
          out.push(`<h2 class="cl-release" id="${esc(release[1])}"><a href="#${esc(release[1])}">${esc(release[1])}</a><span class="cl-when">${esc(release[2])}</span></h2>`);
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(title)) {
          out.push(`<h3 class="cl-date">${esc(title)}</h3>`);
        } else {
          out.push(`<h2 class="cl-earlier">${inline(title)}</h2>`);
        }
      } else if (line.startsWith('- ')) {
        if (para) flush();
        (list ??= []).push(line.slice(2));
      } else if (/^\s+\S/.test(line) && list) {
        list[list.length - 1] += ` ${line.trim()}`;
      } else if (line.trim() === '') {
        flush();
      } else if (!line.startsWith('#')) {
        if (list) flush();
        (para ??= []).push(line.trim());
      }
    }
    flush();
    if (!releases) out.unshift('<p class="cl-note">No release has been published under this changelog yet.</p>');
    return out.join('\n');
  }

  async function load() {
    const main = document.querySelector('main[data-changelog]');
    if (!main) return;
    const file = main.dataset.changelog;
    const body = main.querySelector('[data-changelog-body]');
    // ?src=<path on this site> reads a copy beside the page instead, for trying a change before it is on main.
    const src = new URLSearchParams(location.search).get('src');
    const url = src && /^[\w./-]+$/.test(src) && !src.startsWith('/') ? src : RAW + file;
    try {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      body.innerHTML = render(await res.text());
      if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
    } catch (e) {
      body.innerHTML = `<p class="cl-problem">The changelog could not be loaded from GitHub just now (${esc(String(e.message || e))}). `
        + `Read it on GitHub instead: <a href="${esc(BLOB + file)}">${esc(file)}</a>.</p>`;
    }
  }

  window.ledungChangelog = { render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
  else load();
})();
