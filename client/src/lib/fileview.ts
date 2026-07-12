// ── Shared read-only file-view helpers ────────────────────────────────────────────────────────
// A copied path (clipboard preview) or a file picked in the explorer can be shown read-only. This
// module holds the pure helpers both features share: path sniffing, size formatting, and the
// Markdown renderer (marked + DOMPurify). Kept UI-free so it can be imported anywhere.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

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

// Markdown → sanitized HTML for the read-only previews. `marked` provides full CommonMark + GFM
// (tables, nested lists, strikethrough, task lists, autolinks — the hand-rolled renderer this
// replaces mis-parsed real-world tables), and DOMPurify sanitizes the OUTPUT afterwards, so a
// rendered file can't inject markup or a javascript: URL no matter what marked emits.
marked.use({ gfm: true, breaks: false });

// Preview links open in a new tab and never carry the opener. Applied post-sanitize, so the
// attributes can't be spoofed by the source document.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// Single-entry memo: both consumers call this inline on every React render (via
// dangerouslySetInnerHTML), and a preview can be up to 2 MB (the server's view cap) — re-running
// marked + DOMPurify on each keystroke of a nearby input would jank the UI thread.
let lastSrc: string | null = null;
let lastHtml = '';

export function renderMarkdown(src: string): string {
  const s = src || '';
  if (s === lastSrc) return lastHtml;
  let html: string;
  try {
    html = marked.parse(s, { async: false }) as string;
  } catch {
    // marked can throw on pathological input (e.g. very deep blockquote nesting overflows its
    // tokenizer); fall back to an escaped <pre> instead of letting a render-time throw unmount
    // the whole React root (there is no error boundary above the previews).
    html = `<pre>${s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))}</pre>`;
  }
  lastSrc = s;
  lastHtml = DOMPurify.sanitize(html, {
    // Previews render OTHER PEOPLE'S files (repo READMEs etc.). Beyond DOMPurify's XSS defaults,
    // drop resource-loading and form tags so a rendered document can't fire GETs at arbitrary or
    // LAN hosts (tracking pixels, router endpoints) or fake a credential form. <input> stays —
    // GFM task-list checkboxes need it (marked emits them disabled).
    FORBID_TAGS: ['img', 'picture', 'source', 'video', 'audio', 'iframe', 'form', 'button'],
    FORBID_ATTR: ['action', 'formaction'],
  });
  return lastHtml;
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
