import { useEffect, useState, FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { AdminUser } from '../types';

export default function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    setUsers(await api.get('/users'));
  }
  useEffect(() => {
    load();
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setErr('');
    try {
      await api.post('/users', { username: username.trim(), password, is_admin: isAdmin });
      setUsername('');
      setPassword('');
      setIsAdmin(false);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function del(id: number) {
    if (!confirm('删除该用户？其分组数据会一并删除。')) return;
    try {
      await api.del(`/users/${id}`);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }
  async function resetPw(id: number) {
    const p = prompt('设置新密码（至少 4 位）');
    if (!p) return;
    try {
      await api.post(`/users/${id}/password`, { password: p });
      alert('已重置');
    } catch (e) {
      alert((e as Error).message);
    }
  }

  return (
    <div className="admin">
      <div className="admin-head">
        <Link to="/">← 返回控制台</Link>
        <h2>用户管理</h2>
      </div>
      <form className="user-add" onSubmit={add}>
        <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
        <input placeholder="密码" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label className="chk">
          <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} /> 管理员
        </label>
        <button>添加用户</button>
      </form>
      {err && <div className="err">{err}</div>}
      <table className="user-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>用户名</th>
            <th>角色</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.id}</td>
              <td>{u.username}</td>
              <td>{u.is_admin ? '管理员' : '用户'}</td>
              <td>{(u.created_at || '').slice(0, 19).replace('T', ' ')}</td>
              <td>
                <button className="link" onClick={() => resetPw(u.id)}>
                  重置密码
                </button>{' '}
                <button className="link danger" onClick={() => del(u.id)}>
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
