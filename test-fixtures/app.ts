// SPDX-License-Identifier: MPL-2.0
import { Request, Response } from 'express';

export interface UserSession {
    userId: string;
    role: 'admin' | 'editor' | 'viewer';
    tokenExpiresAt: number;
}

export class AuthenticationService {
    private activeTokens = new Map<string, UserSession>();

    public async authenticate(req: Request, res: Response): Promise<UserSession | null> {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing or malformed Authorization header' });
            return null;
        }

        const token = authHeader.slice(7).trim();
        const session = this.activeTokens.get(token);

        if (!session) {
            res.status(403).json({ error: 'Invalid token' });
            return null;
        }

        if (Date.now() > session.tokenExpiresAt) {
            this.activeTokens.delete(token);
            res.status(401).json({ error: 'Token expired' });
            return null;
        }

        return session;
    }

    public revokeSession(token: string): boolean {
        return this.activeTokens.delete(token);
    }
}
