import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './auth';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Admin from './pages/Admin';

// The diff page pulls in react-diff-view; lazy-load it so the terminal-heavy Dashboard bundle
// pays none of those bytes until the user actually opens /repos.
const Repos = lazy(() => import('./pages/Repos'));

function Protected({ children, admin }: { children: JSX.Element; admin?: boolean }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center">加载中…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (admin && !user.is_admin) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Protected><Dashboard /></Protected>} />
      <Route path="/admin" element={<Protected admin><Admin /></Protected>} />
      <Route
        path="/repos"
        element={
          <Protected>
            <Suspense fallback={<div className="center">加载中…</div>}>
              <Repos />
            </Suspense>
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
