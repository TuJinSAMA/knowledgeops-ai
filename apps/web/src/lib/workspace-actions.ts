"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AuthzError, requireWorkspaceMember } from "./authz";
import { type ActionState, withLocalePath } from "./action-errors";
import { requireUser } from "./session";
import { createWorkspaceForUser, renameWorkspace } from "./workspace";

export type { ActionState } from "./action-errors";
export type RenameWorkspaceActionState = ActionState & { ok?: boolean };

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
    return { errorCode: "WORKSPACE_NAME_REQUIRED" };
  }

  const workspace = await createWorkspaceForUser(user.id, name);
  redirect(await withLocalePath(`/${workspace.slug}`));
}

/**
 * Rename a workspace. Requires ADMIN or higher in that workspace.
 */
export async function renameWorkspaceAction(
  workspaceId: string,
  slug: string,
  _prev: RenameWorkspaceActionState,
  formData: FormData,
): Promise<RenameWorkspaceActionState> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { errorCode: "WORKSPACE_NAME_REQUIRED" };
  }

  try {
    await requireWorkspaceMember(workspaceId, "ADMIN");
  } catch (error) {
    if (error instanceof AuthzError) {
      return { errorCode: "AUTHORIZATION_FAILED" };
    }
    throw error;
  }

  await renameWorkspace(workspaceId, name);
  revalidatePath(`/${slug}`, "layout");
  revalidatePath(await withLocalePath(`/${slug}`), "layout");
  return { ok: true };
}
