const finite = (value, fallback) => (
  Number.isFinite(Number(value)) ? Number(value) : fallback
);

export function readVisualViewport(target) {
  const win = target || (typeof window !== 'undefined' ? window : null);
  if (!win) return { offsetLeft: 0, offsetTop: 0, width: 0, height: 0 };
  const fallbackWidth = Math.max(0, finite(win.innerWidth, 0));
  const fallbackHeight = Math.max(0, finite(win.innerHeight, 0));
  const viewport = win.visualViewport;
  if (!viewport) {
    return {
      offsetLeft: 0,
      offsetTop: 0,
      width: fallbackWidth,
      height: fallbackHeight,
    };
  }
  return {
    offsetLeft: Math.max(0, finite(viewport.offsetLeft, 0)),
    offsetTop: Math.max(0, finite(viewport.offsetTop, 0)),
    width: Math.max(0, finite(viewport.width, fallbackWidth)),
    height: Math.max(0, finite(viewport.height, fallbackHeight)),
  };
}

export function viewportRectsEqual(a, b) {
  return a.offsetLeft === b.offsetLeft
    && a.offsetTop === b.offsetTop
    && a.width === b.width
    && a.height === b.height;
}

// Five key rows remain usable on short landscape viewports without consuming the whole CLI.
export function mobileKeyboardHeight(viewportHeight) {
  const height = Math.max(0, finite(viewportHeight, 0));
  if (!height) return 0;
  const preferred = Math.max(150, height * 0.42);
  const leaveForTerminal = Math.max(96, height - 96);
  return Math.round(Math.max(96, Math.min(300, preferred, leaveForTerminal)));
}
