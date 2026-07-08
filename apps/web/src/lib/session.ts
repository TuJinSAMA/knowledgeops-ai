import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth, type Session } from "./auth";

export type SessionUser = Session["user"];

/**
 * Read the current session on the server (App Router server components, route
 * handlers, server actions). Returns null when no valid session exists.
 */
export async function getServerSession(): Promise<Session | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session ?? null;
}

/**
 * Require an authenticated user. Redirects unauthenticated visitors to the
 * sign-in page (preserving the requested path for post-login return).
 */
export async function requireUser(callbackPath?: string): Promise<SessionUser> {
  const session = await getServerSession();
  if (!session?.user) {
    const target = callbackPath
      ? `/sign-in?callbackUrl=${encodeURIComponent(callbackPath)}`
      : "/sign-in";
    redirect(target);
  }
  return session.user;
}
