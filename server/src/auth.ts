
import { Request, Response, NextFunction } from 'express';
// MVP stubs. Replace with Zoho OAuth validation and user lookup.
export type Role = 'Enrollment Specialist' | 'Senior Contract Specialist' | 'Manager' | 'Admin';
declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      fullName: string;
      role: Role;
      managerUserId?: string;
    }
    interface Request {
      user: User;
    }
  }
}
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // In dev we fake a user. In prod, populate from Zoho token/session.
  if (!req.headers['x-dev-user']) {
    // default to non-manager for local testing
    req.user = {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'agent@example.com',
      fullName: 'Agent Example',
      role: 'Enrollment Specialist',
      managerUserId: '00000000-0000-0000-0000-000000000099'
    };
  } else {
    try {
      req.user = JSON.parse(String(req.headers['x-dev-user']));
    } catch {
      return res.status(400).json({ error: 'Bad x-dev-user header' });
    }
  }
  return next();
}
export function requireRole(roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}
