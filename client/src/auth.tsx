import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { api, setToken, getToken } from './api';
import { User } from './types';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  updateUser: (patch: Partial<User>) => void;
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .get('/auth/me')
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  async function login(username: string, password: string) {
    const r = await api.post('/auth/login', { username, password });
    setToken(r.token);
    setUser(r.user);
  }

  function logout() {
    setToken(null);
    setUser(null);
    location.href = '/login';
  }

  function updateUser(patch: Partial<User>) {
    setUser((u) => (u ? { ...u, ...patch } : u));
  }

  return (
    <Ctx.Provider value={{ user, loading, login, logout, updateUser }}>{children}</Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
