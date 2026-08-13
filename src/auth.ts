import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { Database } from './db.js';
import { getSessionAdministrator } from './db.js';
import { safeEqual } from './lib/crypto.js';

export const adminCookieName = 'villa_admin_session';

export interface AdminSessionUser {
  id: string;
  email: string;
  display_name: string;
  csrf_token: string;
  session_id: string;
}

export function getAdmin(request: FastifyRequest, db: Database): AdminSessionUser | undefined {
  return getSessionAdministrator(db, request.cookies[adminCookieName]) as AdminSessionUser | undefined;
}

export function requireAdmin(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const admin = getAdmin(request, db);
    if (!admin) {
      return reply.redirect(`/admin/login?returnTo=${encodeURIComponent(request.url)}`);
    }
    (request as FastifyRequest & { admin: AdminSessionUser }).admin = admin;
  };
}

export function requireAdminApi(db: Database) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const admin = getAdmin(request, db);
    if (!admin) return reply.code(401).send({ error: 'Authentication required' });
    (request as FastifyRequest & { admin: AdminSessionUser }).admin = admin;
  };
}

export function requireCsrf() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const admin = (request as FastifyRequest & { admin?: AdminSessionUser }).admin;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = typeof body._csrf === 'string' ? body._csrf : '';
    if (!admin || !token || !safeEqual(token, admin.csrf_token)) {
      return reply.code(403).view('error.njk', { title: 'Request blocked', message: 'This form expired or could not be verified.' });
    }
  };
}

export function setAdminCookie(reply: FastifyReply, config: AppConfig, token: string, expiresAt: number): void {
  reply.setCookie(adminCookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secureCookies,
    expires: new Date(expiresAt * 1000),
  });
}

export function clearAdminCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(adminCookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.secureCookies });
}

export function adminFromRequest(request: FastifyRequest): AdminSessionUser {
  const admin = (request as FastifyRequest & { admin?: AdminSessionUser }).admin;
  if (!admin) throw new Error('Administrator session missing');
  return admin;
}
