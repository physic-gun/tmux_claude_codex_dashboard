import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await login(u, p);
      nav('/');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>🖥️ Tmux Dashboard</h1>
        <input placeholder="用户名" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
        <input placeholder="密码" type="password" value={p} onChange={(e) => setP(e.target.value)} />
        {err && <div className="err">{err}</div>}
        <button disabled={busy || !u || !p}>{busy ? '登录中…' : '登录'}</button>
      </form>
    </div>
  );
}
