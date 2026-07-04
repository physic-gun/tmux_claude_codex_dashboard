import { useRef, useState } from 'react';

// Shows raw git output (a conflict, a rejected push, an auth failure) in a read-only, selectable
// textarea with a one-click copy — used by both the rail (pull) and the diff page (commit/push/pull).
export default function GitOutputModal({
  title,
  output,
  onClose,
}: {
  title: string;
  output: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  async function copy() {
    try {
      if (window.isSecureContext && navigator.clipboard) {
        await navigator.clipboard.writeText(output);
      } else {
        taRef.current?.select();
        document.execCommand('copy');
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // last resort: select the text so the user can copy manually
      taRef.current?.select();
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal git-output-modal">
        <div className="modal-title">{title}</div>
        <textarea
          ref={taRef}
          className="git-output"
          readOnly
          value={output}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="modal-actions">
          <button className="btn-ghost" onClick={copy}>{copied ? '已复制 ✓' : '复制报错'}</button>
          <button className="btn-primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
