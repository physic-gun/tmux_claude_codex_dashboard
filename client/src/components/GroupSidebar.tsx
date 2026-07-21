import { useState, FormEvent } from 'react';
import { Group, WindowActivity } from '../types';
import ManualPathModal from './ManualPathModal';
import { GroupActivityDots } from './ActivityDots';

interface Props {
  groups: Group[];
  activities: WindowActivity[];
  activeGid: number | null;
  onSelect: (id: number) => void;
  onCreate: (name: string) => Promise<void> | void;
  onCreatePath: (name: string, path: string) => Promise<void>;
  onDelete: (id: number) => void;
  onReorder: (ids: number[]) => void;
  // Refresh a group's .gitignore to exclude nested git repos (manage-mode action).
  onUpdateIgnore: (id: number) => void;
}

export default function GroupSidebar({ groups, activities, activeGid, onSelect, onCreate, onCreatePath, onDelete, onReorder, onUpdateIgnore }: Props) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [pathModalOpen, setPathModalOpen] = useState(false);
  // "Manage" mode reveals reorder + delete controls; off by default so the list stays clean.
  const [manage, setManage] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setErr('');
    try {
      await onCreate(name.trim());
      setName('');
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // Swap a group with its neighbor and persist the new id order.
  function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= groups.length) return;
    const ids = groups.map((g) => g.id);
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    onReorder(ids);
  }

  return (
    <div className="groups">
      <div className="groups-head">
        <div className="section-title">我的分组</div>
        <button
          className={`manage-btn${manage ? ' on' : ''}`}
          title={manage ? '退出管理' : '管理分组（排序 / 删除）'}
          onClick={() => setManage((m) => !m)}
        >
          {manage ? '完成' : '管理'}
        </button>
        <button className="manual-path-btn" title="用自定义路径新建分组" onClick={() => setPathModalOpen(true)}>
          ManualPath
        </button>
      </div>
      <ul className="group-list">
        {groups.map((g, idx) => (
          <li key={g.id} className={`${g.id === activeGid ? 'active' : ''}${manage ? ' managing' : ''}`}>
            <span className="group-name" onClick={() => onSelect(g.id)}>
              <span className="group-label">{g.name}</span>
              <GroupActivityDots activities={activities.filter((activity) => activity.groupId === g.id)} />
            </span>
            {manage && (
              <span className="group-actions">
                <button
                  className="reorder"
                  title="更新 .gitignore：排除组内本身就是 git 仓库的子文件夹（避免被当成嵌套仓库）"
                  onClick={() => onUpdateIgnore(g.id)}
                >
                  ⟳
                </button>
                <button className="reorder" title="上移" disabled={idx === 0} onClick={() => move(idx, -1)}>▲</button>
                <button className="reorder" title="下移" disabled={idx === groups.length - 1} onClick={() => move(idx, 1)}>▼</button>
                <button
                  className="x"
                  title="删除分组"
                  onClick={() => {
                    if (confirm(`删除分组「${g.name}」？将结束该分组的所有窗口（不会删除磁盘上的任何文件；若目录内还有文件则会拒绝删除）。`)) onDelete(g.id);
                  }}
                >
                  ×
                </button>
              </span>
            )}
          </li>
        ))}
        {groups.length === 0 && <li className="muted small">还没有分组</li>}
      </ul>
      <form onSubmit={add} className="add-group">
        <input placeholder="新分组名" value={name} onChange={(e) => setName(e.target.value)} />
        <button title="创建分组">＋</button>
      </form>
      {err && <div className="err small">{err}</div>}
      {pathModalOpen && (
        <ManualPathModal onClose={() => setPathModalOpen(false)} onCreate={onCreatePath} />
      )}
    </div>
  );
}
