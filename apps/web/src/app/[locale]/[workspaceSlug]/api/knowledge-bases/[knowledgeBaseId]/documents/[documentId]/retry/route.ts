import { NextResponse } from "next/server";

import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { AuthzError, requireWorkspaceMemberBySlug } from "@/lib/authz";
import { retryDocumentIngestion, UploadError } from "@/lib/document-upload";

type RouteParams = {
  params: Promise<{
    workspaceSlug: string;
    knowledgeBaseId: string;
    documentId: string;
  }>;
};

/** Retry ingestion for a FAILED document without re-uploading bytes. */
export async function POST(_request: Request, { params }: RouteParams) {
  const { workspaceSlug, knowledgeBaseId, documentId } = await params;
  try {
    const { workspaceId, user } = await requireWorkspaceMemberBySlug(
      workspaceSlug,
      "ADMIN",
    );
    const retried = await retryDocumentIngestion({
      workspaceId,
      knowledgeBaseId,
      documentId,
    });
    await recordAudit({
      workspaceId,
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_RETRY_INGEST,
      target: { type: "document", id: retried.id },
      metadata: {
        knowledge_base_id: knowledgeBaseId,
        title: retried.title,
      },
    });
    return NextResponse.json({ document: retried });
  } catch (error) {
    if (error instanceof AuthzError) {
      return NextResponse.json(
        { error: error.message, errorCode: "AUTHORIZATION_FAILED" },
        { status: error.status },
      );
    }
    if (error instanceof UploadError) {
      return NextResponse.json(
        { error: error.message, errorCode: error.code },
        { status: error.status },
      );
    }
    throw error;
  }
}
