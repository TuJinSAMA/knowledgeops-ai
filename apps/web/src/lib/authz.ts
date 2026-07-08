import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { workspaceMembers, workspaces } from "@/db/schema";
import { getServerSession, type SessionUser } from "./session";

export type WorkspaceRole = (typeof workspaceMembers.$inferSelect)["role"];
export type WorkspaceMembership = typeof workspaceMembers.$inferSelect;

// Role hierarchy: OWNER > ADMIN > MEMBER. Higher rank implies all lower powers.
const ROLE_RANK: Record<WorkspaceRole, number> = {
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

/** Pure helper: does `role` satisfy the `minRole` requirement? */
export function hasMinRole(role: WorkspaceRole, minRole: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/**
 * Authorization error carrying an HTTP status so route handlers can translate
 * it into a response (401 unauthenticated, 403 forbidden).
 */
export class AuthzError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthzError";
    this.status = status;
  }
}

export type WorkspaceMemberContext = {
  user: SessionUser;
  membership: WorkspaceMembership;
  role: WorkspaceRole;
};

/**
 * The single server-side guard for tenant + role isolation. Verifies that the
 * current user is authenticated, is a member of `workspaceId`, and holds at
 * least `minRole`. Returns the resolved context, or throws AuthzError.
 *
 * All business APIs/server actions should funnel workspace access through this
 * guard so tenant isolation and RBAC are enforced in exactly one place.
 */
export async function requireWorkspaceMember(
  workspaceId: string,
  minRole: WorkspaceRole = "MEMBER",
): Promise<WorkspaceMemberContext> {
  const session = await getServerSession();
  if (!session?.user) {
    throw new AuthzError(401, "Authentication required");
  }

  const [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, session.user.id),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new AuthzError(403, "Not a member of this workspace");
  }

  if (!hasMinRole(membership.role, minRole)) {
    throw new AuthzError(
      403,
      `Requires ${minRole} role or higher in this workspace`,
    );
  }

  return { user: session.user, membership, role: membership.role };
}

/**
 * Slug-based variant of {@link requireWorkspaceMember}. Resolves the workspace
 * by slug and enforces the same checks, returning the workspace id alongside
 * the member context. Throws 403 when the workspace is missing or inaccessible
 * (deliberately not distinguishing "not found" from "forbidden" to avoid
 * leaking workspace existence across tenants).
 */
export async function requireWorkspaceMemberBySlug(
  slug: string,
  minRole: WorkspaceRole = "MEMBER",
): Promise<WorkspaceMemberContext & { workspaceId: string }> {
  const session = await getServerSession();
  if (!session?.user) {
    throw new AuthzError(401, "Authentication required");
  }

  const [row] = await db
    .select({ membership: workspaceMembers, workspaceId: workspaces.id })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, session.user.id),
      ),
    )
    .where(eq(workspaces.slug, slug))
    .limit(1);

  if (!row) {
    throw new AuthzError(403, "Not a member of this workspace");
  }

  if (!hasMinRole(row.membership.role, minRole)) {
    throw new AuthzError(
      403,
      `Requires ${minRole} role or higher in this workspace`,
    );
  }

  return {
    user: session.user,
    membership: row.membership,
    role: row.membership.role,
    workspaceId: row.workspaceId,
  };
}
