import { eq } from 'drizzle-orm'
import { db } from '../../host/db'
import { localAdmins } from '../../host/schema'

// The break-glass local admins' rows (core/local-login.ts decides who they are).

export async function anyLocalAdmin(): Promise<boolean> {
  return (await db.select({ id: localAdmins.id }).from(localAdmins).limit(1)).length > 0
}

export async function findLocalAdmin(
  username: string,
): Promise<{ id: string; username: string; passwordHash: string } | null> {
  const [row] = await db
    .select({
      id: localAdmins.id,
      username: localAdmins.username,
      passwordHash: localAdmins.passwordHash,
    })
    .from(localAdmins)
    .where(eq(localAdmins.username, username))
    .limit(1)
  return row ?? null
}

export async function insertLocalAdmin(username: string, passwordHash: string): Promise<void> {
  await db.insert(localAdmins).values({ username, passwordHash })
}

export async function stampLocalAdminLogin(id: string): Promise<void> {
  await db.update(localAdmins).set({ lastLoginAt: new Date() }).where(eq(localAdmins.id, id))
}
