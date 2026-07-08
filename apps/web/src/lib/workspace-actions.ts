"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AuthzError, requireWorkspaceMember } from "./authz";
import { requireUser } from "./session";
import { createWorkspaceForUser, renameWorkspace } from "./workspace";

export type ActionState = { error?: string };

/**
 * Create a new workspace owned by the current user, then navigate into it.
 * Used by the onboarding / "new workspace" form.
 */
export async function createWorkspaceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { error: "Workspace name is required" };
  }

  const workspace = await createWorkspaceForUser(user.id, name);
  redirect(`/${workspace.slug}`);
}

/**
 * Rename a workspace. Requires ADMIN or higher in that workspace.
 */
export async function renameWorkspaceAction(
  workspaceId: string,
  slug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { error: "Workspace name is required" };
  }

  try {
    await requireWorkspaceMember(workspaceId, "ADMIN");
  } catch (error) {
    if (error instanceof AuthzError) {
      return { error: error.message };
    }
    throw error;
  }

  await renameWorkspace(workspaceId, name);
  revalidatePath(`/${slug}`, "layout");
  return {};
}
