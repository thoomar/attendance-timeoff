// src/routes/me.ts
import { Router } from 'express';
import { requireAuth } from '../auth';

const r = Router();

r.get('/', requireAuth, (req, res) => {
    const u = req.user;
    res.json({
        ok: true,
        user: { id: u.id, name: u.fullName, email: u.email, role: u.role || 'Employee' },
    });
});

export default r;
