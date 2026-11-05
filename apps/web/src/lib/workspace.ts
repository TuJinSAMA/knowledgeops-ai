import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { workspaceMembers, workspaces } from "@/db/schema";

// Slugs that collide with top-level routes or framework paths and therefore
// must never be assigned to a workspace.
const RESERVED_SLUGS = new Set([
  "en",
  "zh",
  "api",
  "sign-in",
  "sign-up",
  "workspaces",
  "onboarding",
  "_next",
  "favicon.ico",
]);

const MAX_SLUG_LENGTH = 40;

export type WorkspaceSummary = {
  id: string;
  name: string;
  slug: string;
  role: (typeof workspaceMembers.$inferSelect)["role"];
};

/** Normalize an arbitrary string into a URL-safe slug base. */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  return base.length > 0 ? base : "workspace";
}

/**
 * Find a unique slug derived from `desired`, appending a numeric suffix on
 * collision (and avoiding reserved slugs).
 */
async function resolveUniqueSlug(desired: string): Promise<string> {
  const base = slugify(desired);
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-1` : base;
  let suffix = 1;

  // Bounded loop: in practice collisions are rare; cap to avoid runaway.
  while (suffix < 1000) {
    const existing = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, candidate))
      .limit(1);
    if (existing.length === 0) {
      return candidate;
    }
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  // Extremely unlikely fallback: random suffix.
  return `${base}-${Date.now().toString(36)}`;
}

/** Default workspace name for a freshly registered user. */
function defaultWorkspaceName(name?: string | null, email?: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) {
    return `${trimmed}'s Workspace`;
  }
  const local = email?.split("@")[0]?.trim();
  if (local) {
    return `${local}'s Workspace`;
  }
  return "My Workspace";
}

/**
 * Create a workspace and add `userId` as its OWNER. Returns the new workspace.
 * Performed in a single transaction so a workspace never exists without an owner.
 */
export async function createWorkspaceForUser(
  userId: string,
  name: string,
  role: WorkspaceSummary["role"] = "OWNER",
): Promise<WorkspaceSummary> {
  const slug = await resolveUniqueSlug(name);

  return db.transaction(async (tx) => {
    const [workspace] = await tx
      .insert(workspaces)
      .values({ name: name.trim() || "Workspace", slug })
      .returning();

    await tx.insert(workspaceMembers).values({
      workspaceId: workspace.id,
      userId,
      role,
    });

    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      role,
    };
  });
}

/**
 * Idempotently ensure the user belongs to at least one workspace. If they have
 * no membership yet, create a default workspace (OWNER). Safe to call on every
 * login; it does not create duplicates for users who already have a workspace.
 */
export async function ensureWorkspaceForUser(user: {
  id: string;
  name?: string | null;
  email?: string | null;
}): Promise<void> {
  const existing = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, user.id))
    .limit(1);

  if (existing.length > 0) {
    return;
  }

  await createWorkspaceForUser(
    user.id,
    defaultWorkspaceName(user.name, user.email),
  );
}

/** List all workspaces the user is a member of, with their role. */
export async function listUserWorkspaces(
  userId: string,
): Promise<WorkspaceSummary[]> {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaces.createdAt);
}

/**
 * Resolve a workspace by slug for a specific user, returning null when the
 * workspace does not exist or the user is not a member. Used to enforce that a
 * user can only see workspaces they belong to.
 */
export async function getUserWorkspaceBySlug(
  userId: string,
  slug: string,
): Promise<WorkspaceSummary | null> {
  const [row] = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      role: workspaceMembers.role,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(eq(workspaces.slug, slug))
    .limit(1);

  return row ?? null;
}

/** Rename a workspace. Caller is responsible for authorization. */
export async function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Workspace name cannot be empty");
  }
  await db
    .update(workspaces)
    .set({ name: trimmed, updatedAt: sql`now()` })
    .where(eq(workspaces.id, workspaceId));
}
