import { useRef, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';

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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[640px]">
        <DialogTitle>{title}</DialogTitle>
        <textarea
          ref={taRef}
          className="git-output"
          readOnly
          value={output}
          spellCheck={false}
          onFocus={(e) => e.currentTarget.select()}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={copy}>{copied ? '已复制 ✓' : '复制报错'}</Button>
          <Button onClick={onClose}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
