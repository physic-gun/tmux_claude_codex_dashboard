import { Router } from 'express';
import { authRequired } from '../auth.js';
import { pathStat, completePath } from '../workspace.js';

// Filesystem helpers for the custom-path group dialog. Any logged-in user can stat/list host
// directories — acceptable here because every user already has a full shell in their windows.
const router = Router();
router.use(authRequired);

// Does this path exist, and is it a directory? Drives the validate button (确定/创建).
router.get('/validate', (req, res) => {
  res.json(pathStat(String(req.query.path || '')));
});

// CLI-style directory-name completion for the path input (Tab key).
router.get('/complete', (req, res) => {
  res.json(completePath(String(req.query.path || '')));
});

export default router;
