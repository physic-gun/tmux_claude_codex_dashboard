import type { WindowActivity } from '../types';
import { WindowActivityDots } from './ActivityDots';

interface Props {
  windows: string[];
  activities?: Record<string, WindowActivity>;
  onReopen: (n: string) => void;
  onKill: (n: string) => void;
}

export default function BackgroundWindows({ windows, activities, onReopen, onKill }: Props) {
  if (!windows.length) return null;
  return (
    <div className="bgwins">
      <span className="section-title">后台窗口（仍在运行）</span>
      <div className="bg-list">
        {windows.map((w) => (
          <span key={w} className="chip bg">
            <button onClick={() => onReopen(w)} title="恢复为选项卡">
              <WindowActivityDots activity={activities?.[w]} />
              {w}
            </button>
            <button className="x" title="结束该窗口" onClick={() => onKill(w)}>
              🗑
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
