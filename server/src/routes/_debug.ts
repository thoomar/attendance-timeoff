// src/routes/_debug.ts
import { Router } from 'express';
import { requireAuth } from '../auth';

const router = Router();

// Debug endpoint to check current session/user
router.get('/session', requireAuth, (req, res) => {
    res.json({
        user: req.user,
        sessionID: req.sessionID,
    });
});

export default router;
