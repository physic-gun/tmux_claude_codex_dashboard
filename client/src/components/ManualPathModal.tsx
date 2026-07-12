import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface Stat { ok: boolean; resolved?: string; exists?: boolean; isDir?: boolean; error?: string }

const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

// Group name defaults to the folder's basename, with characters tmux/group names disallow
// replaced by '_' so it satisfies NAME_RE.
function deriveName(p: string) {
  const base = p.replace(/\/+$/, '').split('/').pop() || '';
  let n = base.replace(/[^A-Za-z0-9_-]/g, '_');
  if (n && !/^[A-Za-z0-9_]/.test(n)) n = '_' + n;
  return n;
}

export default function ManualPathModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, path: string) => Promise<void>;
}) {
  const [pathInput, setPathInput] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [stat, setStat] = useState<Stat | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const debRef = useRef<number | undefined>(undefined);
  const reqRef = useRef(0); // epoch so a slow validate response can't overwrite a newer one

  // Set the path and (until the user edits the name field) keep the name synced to its basename.
  function setPath(p: string) {
    setPathInput(p);
    if (!nameEdited) setName(deriveName(p));
  }

  // Debounced live validation drives the status line + the action button label.
  useEffect(() => {
    const p = pathInput.trim();
    if (debRef.current) window.clearTimeout(debRef.current);
    if (!p) { setStat(null); return; }
    debRef.current = window.setTimeout(async () => {
      const id = ++reqRef.current;
      try {
        const r = await api.get(`/fs/validate?path=${encodeURIComponent(p)}`);
        if (id === reqRef.current) setStat(r);
      } catch {
        if (id === reqRef.current) setStat(null);
      }
    }, 220);
    return () => { if (debRef.current) window.clearTimeout(debRef.current); };
  }, [pathInput]);

  // CLI-style Tab completion: one match → complete it; several → extend to the common prefix
  // and list them; none → nothing.
  async function complete() {
    const p = pathInput.trim();
    if (!p) return;
    try {
      const r = await api.get(`/fs/complete?path=${encodeURIComponent(p)}`);
      const matches: string[] = r.matches || [];
      if (matches.length === 1) { setPath(matches[0] + '/'); setSuggestions([]); }
      else if (matches.length > 1) {
        if (typeof r.common === 'string' && r.common.length > p.length) setPath(r.common);
        setSuggestions(matches);
      } else setSuggestions([]);
    } catch { /* ignore */ }
  }

  function pick(s: string) {
    setPath(s + '/');
    setSuggestions([]);
    inputRef.current?.focus();
  }

  const trimmed = pathInput.trim();
  const isFile = !!stat?.exists && !stat?.isDir;
  // A loaded stat that errored (e.g. relative path) or points at a file → not submittable.
  const pathInvalid = !!stat && (stat.ok === false || isFile);
  const nameOk = NAME_RE.test(name);
  const canSubmit = !!trimmed && !pathInvalid && nameOk && !busy;
  const btnLabel = stat?.exists ? '确定' : '创建';

  async function submit() {
    if (!trimmed) return;
    if (stat && stat.ok === false) { setErr(stat.error || '路径无效'); return; }
    if (isFile) { setErr('该路径是文件，不是文件夹'); return; }
    if (!nameOk) { setErr('分组名只能含字母、数字、_-，且以字母/数字/下划线开头'); return; }
    setErr(''); setBusy(true);
    try {
      await onCreate(name, trimmed);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="path-modal max-w-[560px]">
        <DialogTitle>自定义路径新建分组</DialogTitle>

        <Label className="field-label">路径（Tab 自动补全 · 支持 ~）</Label>
        <div className="path-row">
          <Input
            ref={inputRef}
            autoFocus
            className="path-input"
            placeholder="/Users/you/projects/foo 或 ~/projects/foo"
            value={pathInput}
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab') { e.preventDefault(); complete(); }
              else if (e.key === 'Enter') { e.preventDefault(); submit(); }
            }}
          />
          <Button className="path-go" disabled={!canSubmit} onClick={submit}>{btnLabel}</Button>
        </div>

        <div className="path-status small">
          {trimmed === '' ? <span className="muted">输入一个绝对路径，按 Tab 可补全</span>
            : stat == null ? <span className="muted">检测中…</span>
            : stat.error ? <span className="err">{stat.error}</span>
            : isFile ? <span className="err">该路径是文件，不是文件夹</span>
            : stat.exists ? <span className="ok">✓ 已存在文件夹 —— 点“确定”使用</span>
            : <span className="warn">该路径不存在 —— 点“创建”将新建文件夹</span>}
        </div>

        {suggestions.length > 0 && (
          <div className="path-suggest">
            {suggestions.map((s) => (
              <button key={s} className="suggest-item" onClick={() => pick(s)} title={s}>
                {s.split('/').pop()}/
              </button>
            ))}
          </div>
        )}

        <Label className="field-label">分组名</Label>
        <Input
          className="path-input"
          placeholder="分组名（默认取文件夹名）"
          value={name}
          spellCheck={false}
          onChange={(e) => { setNameEdited(true); setName(e.target.value); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />

        {err && <div className="err small">{err}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>取消</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
