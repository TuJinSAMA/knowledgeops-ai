"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { AUDIT_ACTIONS, recordAudit } from "./audit";
import { type ActionState, withLocalePath } from "./action-errors";
import { AuthzError, requireWorkspaceMemberBySlug } from "./authz";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
  getKnowledgeBase,
  updateKnowledgeBaseRagConfig,
} from "./knowledge-base";
import { parseRagConfigFromFormData } from "./rag-config";

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

/**
 * Update or reset the live RAG configuration of a knowledge base. Requires
 * ADMIN or higher. Records `knowledge-base.update-config` in the audit log.
 */
export async function updateKnowledgeBaseRagConfigAction(
  workspaceSlug: string,
  knowledgeBaseId: string,
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const intent = String(formData.get("intent") ?? "save").trim();
  const parsed =
    intent === "reset"
      ? { config: {} }
      : parseRagConfigFromFormData(formData);
  if ("errorCode" in parsed) {
    return { errorCode: parsed.errorCode };
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

  const kb = await getKnowledgeBase(workspaceId, knowledgeBaseId);
  if (!kb) {
    return { errorCode: "KNOWLEDGE_BASE_NOT_FOUND" };
  }

  const nextConfig =
    Object.keys(parsed.config).length > 0 ? parsed.config : null;
  const updated = await updateKnowledgeBaseRagConfig(
    workspaceId,
    knowledgeBaseId,
    nextConfig,
  );
  if (!updated) {
    return { errorCode: "KNOWLEDGE_BASE_NOT_FOUND" };
  }

  await recordAudit({
    workspaceId,
    actorId,
    action: AUDIT_ACTIONS.KNOWLEDGE_BASE_UPDATE_CONFIG,
    target: { type: "knowledge_base", id: knowledgeBaseId },
    metadata: {
      name: kb.name,
      previous_config: kb.ragConfig ?? null,
      next_config: nextConfig,
      source: "manual",
    },
  });

  revalidatePath(
    await withLocalePath(
      `/${workspaceSlug}/knowledge-bases/${knowledgeBaseId}`,
    ),
  );
  return { ok: true };
}
