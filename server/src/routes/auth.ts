import { Router } from 'express';
import { login, callback, logout } from '../auth/entra';

const router = Router();

router.get('/login', login);
router.get('/callback', callback);
router.post('/logout', logout);

// who am i?
router.get('/me', (req, res) => {
    if (!req.session?.user) return res.status(200).json({ ok: true, user: null });
    return res.json({ ok: true, user: req.session.user });
});

export default router;
