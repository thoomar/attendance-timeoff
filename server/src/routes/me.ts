
import { Router } from 'express';
import { requireAuth } from '../auth';
const r = Router();
r.get('/', requireAuth, (req, res) => {
  res.json({ id: req.user.id, name: req.user.fullName, email: req.user.email, role: req.user.role });
});
export default r;
