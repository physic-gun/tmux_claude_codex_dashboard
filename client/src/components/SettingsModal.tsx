import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { getTheme, setTheme, type Theme } from '../lib/theme';
import {
  TERMINAL_THEMES,
  getTerminalTheme,
} from '../lib/terminalThemes.js';

// Monospace fonts offered for the terminal. Only the primary family name is stored; TerminalView
// always appends a monospace + CJK fallback so alignment survives a font the device lacks.
//
// "内置" fonts ship with the app (self-hosted woff2 in public/fonts, declared in fonts.css) so they
// render on any device. "系统" fonts are referenced by name only — they render solely if the
// visitor's OS has them installed, else they silently fall back to the built-in stack.
const TERM_FONT_GROUPS: { group: string; fonts: { value: string; label: string }[] }[] = [
  {
    group: '内置字体（随应用下发，任意设备可用）',
    fonts: [
      { value: 'Maple Mono CN', label: 'Maple Mono CN（中文等宽 · 含拉丁）' },
      { value: 'JetBrains Mono', label: 'JetBrains Mono' },
      { value: 'Fira Code', label: 'Fira Code' },
      { value: 'Source Code Pro', label: 'Source Code Pro' },
      { value: 'Cascadia Code', label: 'Cascadia Code' },
    ],
  },
  {
    group: '系统字体（仅当本机已安装时生效）',
    fonts: [
      { value: 'SF Mono', label: 'SF Mono' },
      { value: 'Menlo', label: 'Menlo' },
      { value: 'Monaco', label: 'Monaco' },
      { value: 'Consolas', label: 'Consolas' },
      { value: 'Courier New', label: 'Courier New' },
      { value: 'Ubuntu Mono', label: 'Ubuntu Mono' },
    ],
  },
];

// Per-user preferences: scroll-button steps, terminal font/theme, and floating-button opacity.
export default function SettingsModal({
  onClose,
  onTerminalThemePreview,
}: {
  onClose: () => void;
  onTerminalThemePreview: (themeId: string) => void;
}) {
  const { user, updateUser } = useAuth();
  const originalTerminalTheme = getTerminalTheme(user?.term_theme).id;
  const [small, setSmall] = useState(user?.scroll_step_small ?? 20);
  const [big, setBig] = useState(user?.scroll_step_big ?? 60);
  const [auto, setAuto] = useState(!!user?.scroll_auto);
  const [font, setFont] = useState(user?.term_font ?? '');
  const [terminalTheme, setTerminalTheme] = useState(originalTerminalTheme);
  const [opacity, setOpacity] = useState(user?.float_opacity ?? 20);
  // Theme is a client-only preference (localStorage, no server round-trip): apply it live on click
  // so the switch is instant, independent of the 保存 button below (which persists server settings).
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  function chooseTheme(t: Theme) {
    setThemeState(t);
    setTheme(t); // persist + apply to <html> immediately
  }

  function chooseTerminalTheme(themeId: string) {
    setTerminalTheme(themeId);
    onTerminalThemePreview(themeId);
  }

  function cancel() {
    onTerminalThemePreview(originalTerminalTheme);
    onClose();
  }

  async function save() {
    setErr('');
    setBusy(true);
    try {
      const r = await api.post('/auth/settings', {
        scroll_step_small: small, scroll_step_big: big, scroll_auto: auto ? 1 : 0,
        term_font: font, term_theme: terminalTheme, float_opacity: opacity,
      });
      updateUser({
        scroll_step_small: r.scroll_step_small, scroll_step_big: r.scroll_step_big, scroll_auto: r.scroll_auto,
        term_font: r.term_font, term_theme: r.term_theme, float_opacity: r.float_opacity,
      });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  // In auto mode the steps come from the terminal size, so the manual values needn't be valid.
  const validSmall = auto || (Number.isFinite(small) && small >= 1 && small <= 100);
  const validBig = auto || (Number.isFinite(big) && big >= 1 && big <= 500);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) cancel(); }}>
      <DialogContent className="settings-modal max-w-[560px]">
        <DialogTitle>设置</DialogTitle>

        <div className="section-title">外观</div>
        <div className="setting-row">
          <label>界面主题</label>
          <span className="theme-toggle">
            <Button size="sm" variant={theme === 'dark' ? 'default' : 'ghost'} onClick={() => chooseTheme('dark')}>
              🌙 深色
            </Button>
            <Button size="sm" variant={theme === 'light' ? 'default' : 'ghost'} onClick={() => chooseTheme('light')}>
              ☀️ 浅色
            </Button>
          </span>
        </div>

        <div className="section-title" style={{ marginTop: 4 }}>CLI 配色 <span className="muted">（账号同步）</span></div>
        <div className="terminal-theme-list" role="radiogroup" aria-label="CLI 配色">
          {TERMINAL_THEMES.map((preset) => (
            <label
              key={preset.id}
              className={`terminal-theme-option${terminalTheme === preset.id ? ' selected' : ''}`}
            >
              <input
                type="radio"
                name="terminal-theme"
                value={preset.id}
                checked={terminalTheme === preset.id}
                onChange={() => chooseTerminalTheme(preset.id)}
              />
              <span className="terminal-theme-name">
                <span>{preset.label}</span>
                <span className="muted">{preset.description}</span>
              </span>
              <span className="terminal-theme-swatches" aria-hidden="true">
                {preset.swatches.map((color, index) => (
                  <span key={index} style={{ background: color }} />
                ))}
              </span>
            </label>
          ))}
        </div>

        <div className="section-title" style={{ marginTop: 4 }}>滚动步进</div>
        <label className="setting-check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          <span>自动（按界面行数计算）<span className="muted">小步 = 行数×0.25 向上取整，大步 = 行数−10</span></span>
        </label>
        <div className="setting-row">
          <label>小步 <span className="muted">（▲ / ▼ 每次滚动行数，1–100）</span></label>
          <Input type="number" min={1} max={100} disabled={auto} value={Number.isFinite(small) ? small : ''}
            onChange={(e) => setSmall(Number(e.target.value))} />
        </div>
        <div className="setting-row">
          <label>大步 <span className="muted">（▲▲ / ▼▼ 每次滚动行数，1–500）</span></label>
          <Input type="number" min={1} max={500} disabled={auto} value={Number.isFinite(big) ? big : ''}
            onChange={(e) => setBig(Number(e.target.value))} />
        </div>
        <div className="small muted">提示：长按滚动按钮可连续滚动。普通 shell 滚轮/按钮会滚动 tmux 历史。</div>

        <div className="section-title" style={{ marginTop: 4 }}>终端字体</div>
        <div className="setting-row">
          <label>CLI 字体 <span className="muted">（等宽，中文自动回退到系统中文字体）</span></label>
          <select className="setting-select" value={font} onChange={(e) => setFont(e.target.value)}>
            <option value="">默认（系统等宽 + 中文回退）</option>
            {TERM_FONT_GROUPS.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.fonts.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="small muted">提示：内置字体随应用下发、任意设备可用；“Maple Mono CN”含完整中文，首次选用会加载约 5MB。系统字体仅在本机已安装时才生效，否则回退到默认。</div>

        <div className="section-title" style={{ marginTop: 4 }}>悬浮按钮</div>
        <div className="setting-row">
          <label>悬浮按钮透明度 <span className="muted">（收起选项卡/源代码栏后的恢复按钮，5%–100%）</span></label>
          <span className="opacity-control">
            <input type="range" min={5} max={100} step={5} value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))} />
            <span className="opacity-val">{opacity}%</span>
          </span>
        </div>
        <div className="small muted">提示：值越低越不打扰；鼠标悬停时按钮始终完全显示。</div>

        {(!validSmall || !validBig) && <div className="err small">步进需在范围内（小 1–100，大 1–500）</div>}
        {err && <div className="err small">{err}</div>}
        <DialogFooter>
          <Button variant="ghost" onClick={cancel}>取消</Button>
          <Button disabled={busy || !validSmall || !validBig} onClick={save}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
