import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth';
import App from './App';
import '@xterm/xterm/css/xterm.css';
import './fonts.css';
// Tailwind v4 + shadcn tokens FIRST, so the hand-written Tokyo-Night theme below always
// wins the cascade for the terminal / panels / FABs. tailwind.css is additive (no Preflight).
import './tailwind.css';
import './styles.css';
import { applyTheme, getTheme } from './lib/theme';

// The inline boot script in index.html already set data-theme before first paint; re-assert it
// from the same source of truth here so the module owns the value even if that script is removed.
applyTheme(getTheme());

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <AuthProvider>
      <App />
    </AuthProvider>
  </BrowserRouter>
);
