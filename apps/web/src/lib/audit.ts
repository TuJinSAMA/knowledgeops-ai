import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { auditLogs, user } from "@/db/schema";

/**
 * Stable audit action identifiers. Dotted "<entity>.<verb>" form so they are
 * easy to filter and group in the UI. Keep these in sync with the call sites in
 * the various *-actions / upload route modules.
 */
export const AUDIT_ACTIONS = {
  KNOWLEDGE_BASE_CREATE: "knowledge-base.create",
  KNOWLEDGE_BASE_DELETE: "knowledge-base.delete",
  DOCUMENT_UPLOAD: "document.upload",
  DOCUMENT_DELETE: "document.delete",
  MEMBER_ROLE_UPDATE: "member.role-update",
  MEMBER_REMOVE: "member.remove",
  EVALUATION_RUN_TRIGGER: "evaluation-run.trigger",
} as const;

export type AuditAction =
  (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export type AuditTarget = {
  type: string;
  id: string;
};

export type RecordAuditParams = {
  workspaceId: string;
  actorId: string | null;
  action: AuditAction | string;
  target?: AuditTarget | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Append one audit log entry for a consequential write operation. Always scoped
 * to a workspace for tenant isolation. Recording must never break the primary
 * operation, so failures are swallowed (logged) rather than thrown — the audit
 * log is best-effort observability, not a transactional invariant.
 */
export async function recordAudit(params: RecordAuditParams): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      workspaceId: params.workspaceId,
      actorId: params.actorId ?? null,
      action: params.action,
      targetType: params.target?.type ?? null,
      targetId: params.target?.id ?? null,
      metadata: params.metadata ?? null,
    });
  } catch (err) {
    console.error("[audit] failed to record audit entry:", err);
  }
}

export type AuditLogItem = {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  createdAt: Date;
};

export type AuditLogFilters = {
  action?: string | null;
};

/**
 * List audit entries in a workspace (most recent first), optionally filtered to
 * a single action. Scoped by `workspaceId` so entries never leak across tenants.
 * The actor is left-joined so a deleted user (actor_id set null) still renders.
 */
export async function listAuditLogs(
  workspaceId: string,
  filters: AuditLogFilters = {},
  limit = 100,
): Promise<AuditLogItem[]> {
  const conditions = [eq(auditLogs.workspaceId, workspaceId)];
  if (filters.action) {
    conditions.push(eq(auditLogs.action, filters.action));
  }

  return db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      actorId: auditLogs.actorId,
      actorName: user.name,
      actorEmail: user.email,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .leftJoin(user, eq(auditLogs.actorId, user.id))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);
}

/**
 * Return the distinct action values present in a workspace's audit log, for the
 * filter dropdown. Scoped by `workspaceId`.
 */
export async function listAuditActions(
  workspaceId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ action: auditLogs.action })
    .from(auditLogs)
    .where(eq(auditLogs.workspaceId, workspaceId))
    .orderBy(auditLogs.action);
  return rows.map((r) => r.action);
}
