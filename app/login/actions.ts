'use server';

import { redirect } from 'next/navigation';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { users, auditEvent } from '@/lib/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { createSession, destroySession } from '@/lib/auth/session';

export interface LoginState {
  error?: string;
}

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: 'Enter your email and password.' };
  }

  const db = await getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1);

  // Same message either way — a login form should not tell an attacker which
  // half they got right.
  const invalid: LoginState = { error: 'Email or password is incorrect.' };
  if (!user || !user.isActive) return invalid;

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return invalid;

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await db.insert(auditEvent).values({ userId: user.id, action: 'LOGIN', entity: 'users', entityId: user.id });
  await createSession(user.id);

  redirect('/executive');
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect('/login');
}
