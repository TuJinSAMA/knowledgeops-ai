"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { type ActionState, withLocalePath } from "./action-errors";
import { AuthzError, requireWorkspaceMemberBySlug } from "./authz";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
} from "./knowledge-base";

export type { ActionState } from "./action-errors";

/**
 * Create a knowledge base in a workspace and navigate into it. Requires ADMIN
 * or higher (write operation); membership and role are enforced via the slug
 * guard so tenant isolation holds.
 */
export async function createKnowledgeBaseAction(
  workspaceSlug: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!name) {
    return { errorCode: "KNOWLEDGE_BASE_NAME_REQUIRED" };
  }

  let workspaceId: string;
  let actorId: string;
  try {
    const ctx = await requireWorkspaceMemberBySlug(workspaceSlug, "ADMIN");
    workspaceId = ctx.workspaceId;
    actorId = ctx.user.id;
  } catch (error) {
    if (error instanceof AuthzError) {
      return { errorCode: "AUTHORIZATION_FAILED" };
    }
    throw error;
  }

  const kb = await createKnowledgeBase(workspaceId, name, description || null);
  await recordAudit({
    workspaceId,
    actorId,
    action: AUDIT_ACTIONS.KNOWLEDGE_BASE_CREATE,
    target: { type: "knowledge_base", id: kb.id },
    metadata: { name: kb.name },
  });
  revalidatePath(await withLocalePath(`/${workspaceSlug}/knowledge-bases`));
  redirect(await withLocalePath(`/${workspaceSlug}/knowledge-bases/${kb.id}`));
}

/**
 * Delete a knowledge base (cascades to its documents and chunks). Requires
 * ADMIN or higher. Redirects back to the list on success.
 */
export async function deleteKnowledgeBaseAction(
  workspaceSlug: string,
  knowledgeBaseId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  void formData; // useActionState always passes form data; unused for delete.
  let workspaceId: string;
  let actorId: string;
  try {
    const ctx = await requireWorkspaceMemberBySlug(workspaceSlug, "ADMIN");
    workspaceId = ctx.workspaceId;
    actorId = ctx.user.id;
  } catch (error) {
    if (error instanceof AuthzError) {
      return { errorCode: "AUTHORIZATION_FAILED" };
    }
    throw error;
  }

  const deleted = await deleteKnowledgeBase(workspaceId, knowledgeBaseId);
  if (!deleted) {
    return { errorCode: "KNOWLEDGE_BASE_NOT_FOUND" };
  }

  await recordAudit({
    workspaceId,
    actorId,
    action: AUDIT_ACTIONS.KNOWLEDGE_BASE_DELETE,
    target: { type: "knowledge_base", id: knowledgeBaseId },
  });
  revalidatePath(await withLocalePath(`/${workspaceSlug}/knowledge-bases`));
  redirect(await withLocalePath(`/${workspaceSlug}/knowledge-bases`));
}
