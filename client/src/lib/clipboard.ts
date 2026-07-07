// Copy text to the clipboard, reporting whether it actually landed. navigator.clipboard
// only works in a secure context (https or localhost) AND — outside a user gesture — only
// when the browser feels like it (e.g. document focused); on a plain LAN http origin we
// fall back to execCommand, which itself only succeeds inside a user gesture. Callers use
// the returned flag to surface a manual-copy fallback instead of losing the text.
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    // Remember focus (usually the xterm helper textarea) and restore it after, so a
    // copy doesn't silently steal keyboard focus from the terminal.
    const prev = document.activeElement as HTMLElement | null;
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    prev?.focus?.();
    return ok;
  } catch {
    return false; /* clipboard unavailable */
  }
}
