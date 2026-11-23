// 极简 Markdown 渲染（零依赖）：模拟器里模拟手机端 IM 的渲染效果。先转义 HTML，再处理语法，链接只允许 http(s)。
(function () {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(src) {
    const keep = [];
    const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
    let s = src
      .replace(/\\([\\`*_[\]<>|#])/g, (_, c) => hold(esc(c)))
      .replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`))
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => hold(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)}</a>`))
      .replace(/https?:\/\/[^\s<>()]+[^\s<>().,;:!?，。；：！？）]/g, (u) => hold(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`));
    s = esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(.+?)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
  }

  function render(md) {
    const lines = String(md ?? '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    const para = [];
    const flush = () => {
      if (!para.length) return;
      out.push(`<p>${para.map((l) => inline(l.replace(/ {2,}$/, ''))).join('<br>')}</p>`);
      para.length = 0;
    };
    while (i < lines.length) {
      const l = lines[i];
      let m;
      if ((m = l.match(/^\s*(```|~~~)\s*([\w-]*)/))) {
        flush();
        const fence = m[1], lang = m[2];
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++]);
        i++;
        const html = body.map((b) => lang === 'diff' && /^[+-]/.test(b) ? `<span class="${b[0] === '+' ? 'add' : 'del'}">${esc(b)}</span>` : esc(b)).join('\n');
        out.push(`<pre><code>${html}</code></pre>`);
        continue;
      }
      if (!l.trim()) { flush(); i++; continue; }
      if ((m = l.match(/^(#{1,6})\s+(.*)$/))) { flush(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(l)) {
        flush();
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(q.join('\n'))}</blockquote>`);
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
        flush();
        const ordered = /^\s*\d/.test(l);
        const items = [];
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          let item = lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, '');
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) item += '\n' + lines[i++].trim();
          items.push(`<li>${item.split('\n').map((x) => inline(x.replace(/ {2,}$/, ''))).join('<br>')}</li>`);
        }
        out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
        flush();
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        const head = cells(l);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push(`<div class="tbl"><table><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table></div>`);
        continue;
      }
      para.push(l);
      i++;
    }
    flush();
    return out.join('');
  }

  window.renderMarkdown = render;
})();
