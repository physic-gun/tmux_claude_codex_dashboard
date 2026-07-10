// ── Shared read-only file-view helpers ────────────────────────────────────────────────────────
// A copied path (clipboard preview) or a file picked in the explorer can be shown read-only. This
// module holds the pure helpers both features share: path sniffing, size formatting, and a small
// dependency-free, XSS-safe Markdown renderer. Kept UI-free so it can be imported anywhere.

// Derive a single file-path candidate from copied text, so a clip that is just a path can be
// previewed. Only single-line text is considered; one layer of wrapping quotes/backticks is
// stripped, and a trailing :line[:col] reference (as in claude's `src/foo.ts:42`) is dropped.
// Returns '' when the text doesn't look like a path, so we never probe the server for prose.
export function filePathCandidate(text: string): string {
  let s = (text || '').trim();
  if (!s || s.length > 4096 || /[\n\r\t]/.test(s)) return '';
  const wrapped = s.match(/^([`'"])([\s\S]*)\1$/); // strip one layer of matching quotes/backticks
  if (wrapped) s = wrapped[2].trim();
  s = s.replace(/:(\d+)(:\d+)?$/, ''); // drop a trailing path:line[:col] reference
  if (!s || /[\x00-\x1f]/.test(s)) return '';
  // Must plausibly be a path: has a slash, starts with ~ or ./ ../, or is a bare filename.ext.
  const looksPath =
    s.includes('/') || /^~/.test(s) || /^\.\.?\//.test(s) || /^[\w.@+-]+\.[\w]{1,12}$/.test(s);
  return looksPath ? s : '';
}

const MARKDOWN_RE = /\.(md|markdown|mdx|mkd)$/i;
export const isMarkdownPath = (p: string) => MARKDOWN_RE.test(p || '');

// Human-readable byte size for the preview header / notes.
export function fmtSize(n?: number): string {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Minimal, dependency-free, XSS-safe Markdown → HTML for the read-only preview. Everything is
// HTML-escaped FIRST, then a fixed, whitelisted set of tags is introduced; link hrefs are
// scheme-checked so a `javascript:` URL can't sneak through. Not a full CommonMark implementation —
// just enough (headings, code, lists, quotes, emphasis, links, rules) to read a file comfortably.
function escHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
  );
}
// Inline spans over already-escaped text: `code`, links, **bold**/__bold__, *italic*/_italic_.
// Emitted tags (code spans, and each <a…>/</a>) are stashed behind NUL sentinels BEFORE the
// emphasis passes, so a * or _ inside a URL/href can't bleed into the generated markup; the
// link LABEL is left in place so emphasis still applies to it. Sentinels are restored at the end.
function mdInline(escaped: string): string {
  const tokens: string[] = [];
  const stash = (html: string) => `\x00${tokens.push(html) - 1}\x00`;
  let s = escaped.replace(/`([^`]+)`/g, (_m, c) => stash(`<code>${c}</code>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const ok = /^(https?:\/\/|mailto:|\/|\.{0,2}\/|#)/i.test(url) || /^[\w.-]+\//.test(url);
    return ok ? stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">`) + label + stash('</a>') : label;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  return s.replace(/\x00(\d+)\x00/g, (_m, i) => tokens[Number(i)]);
}
export function renderMarkdown(src: string): string {
  const lines = (src || '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${mdInline(escHtml(para.join(' ')))}</p>`); para = []; } };
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  // GFM table helpers: a separator row is cells of optional-colon + dashes + optional-colon; a row is
  // split on unescaped pipes (a leading/trailing pipe is optional, and `\|` is a literal pipe).
  const isTableSep = (s: string) => {
    const t = s.trim();
    return t.includes('-') && t.includes('|') && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
  };
  const splitRow = (s: string) =>
    s.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)/); // fenced code block
    if (fence) {
      flushPara(); closeList();
      const close = fence[1][0] === '`' ? /^\s*```+/ : /^\s*~~~+/;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      i++; // skip the closing fence
      out.push(`<pre class="md-code"><code>${escHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { flushPara(); closeList(); i++; continue; }
    // GFM table: a row containing "|" immediately followed by a |---|:--:| separator row.
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara(); closeList();
      const headers = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const l = c.startsWith(':'); const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') { body.push(splitRow(lines[i])); i++; }
      const cell = (tag: 'th' | 'td', text: string, idx: number) =>
        `<${tag}${aligns[idx] ? ` style="text-align:${aligns[idx]}"` : ''}>${mdInline(escHtml(text || ''))}</${tag}>`;
      let html = '<table class="md-table"><thead><tr>';
      headers.forEach((hc, idx) => { html += cell('th', hc, idx); });
      html += '</tr></thead><tbody>';
      for (const r of body) {
        html += '<tr>';
        for (let idx = 0; idx < headers.length; idx++) html += cell('td', r[idx] ?? '', idx);
        html += '</tr>';
      }
      out.push(html + '</tbody></table>');
      continue;
    }
    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flushPara(); closeList(); out.push(`<h${h[1].length}>${mdInline(escHtml(h[2]))}</h${h[1].length}>`); i++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr />'); i++; continue; }
    const bq = line.match(/^\s{0,3}>\s?(.*)$/);
    if (bq) {
      flushPara(); closeList();
      const buf: string[] = [bq[1]];
      i++;
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${mdInline(escHtml(buf.join(' ')))}</blockquote>`);
      continue;
    }
    const ul = line.match(/^\s{0,3}[-*+]\s+(.*)$/);
    const ol = line.match(/^\s{0,3}\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const t: 'ul' | 'ol' = ul ? 'ul' : 'ol';
      if (listType && listType !== t) closeList();
      if (!listType) { listType = t; out.push(`<${t}>`); }
      out.push(`<li>${mdInline(escHtml(ul ? ul[1] : ol![1]))}</li>`);
      i++; continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara(); closeList();
  return out.join('\n');
}

// The result of probing a path against the filesystem (clipboard-preview detect effect, and the
// explorer's file preview). Mirrors the server's readFileForView descriptor.
export type FileView =
  | { status: 'idle' | 'none' | 'loading' }
  | { status: 'error'; error: string }
  | {
      status: 'ok'; path: string; base?: string | null;
      size?: number; content?: string; truncated?: boolean; binary?: boolean; isFile?: boolean;
    };
