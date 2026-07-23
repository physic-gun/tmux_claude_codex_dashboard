import { useEffect, useState } from 'react';
import { readVisualViewport, viewportRectsEqual } from '../lib/visualViewport.js';

export default function useVisualViewport(enabled = true) {
  const [rect, setRect] = useState(() => readVisualViewport(window));

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const commit = () => {
      frame = 0;
      const next = readVisualViewport(window);
      setRect((current) => (viewportRectsEqual(current, next) ? current : next));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(commit);
    };
    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', schedule);
    viewport?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    commit();
    return () => {
      viewport?.removeEventListener('resize', schedule);
      viewport?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [enabled]);

  return rect;
}
