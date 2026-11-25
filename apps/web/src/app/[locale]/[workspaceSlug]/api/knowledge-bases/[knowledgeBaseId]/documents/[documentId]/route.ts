import { NextResponse } from "next/server";

import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { AuthzError, requireWorkspaceMemberBySlug } from "@/lib/authz";
import {
  deleteDocument,
  replaceDocumentFile,
  UploadError,
} from "@/lib/document-upload";

type RouteParams = {
  params: Promise<{
    workspaceSlug: string;
    knowledgeBaseId: string;
    documentId: string;
  }>;
};

/** Delete a single document (cascades to its chunks and ingestion jobs). */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const { workspaceSlug, knowledgeBaseId, documentId } = await params;
  try {
    const { workspaceId, user } = await requireWorkspaceMemberBySlug(
      workspaceSlug,
      "ADMIN",
    );
    const deleted = await deleteDocument({
      workspaceId,
      knowledgeBaseId,
      documentId,
    });
    await recordAudit({
      workspaceId,
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_DELETE,
      target: { type: "document", id: deleted.id },
      metadata: {
        knowledge_base_id: knowledgeBaseId,
        title: deleted.title,
      },
    });
    return NextResponse.json({ deleted: true });
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

/** Replace an existing document's file in-place (preserving documentId). */
export async function PUT(request: Request, { params }: RouteParams) {
  const { workspaceSlug, knowledgeBaseId, documentId } = await params;
  try {
    const { workspaceId, user } = await requireWorkspaceMemberBySlug(
      workspaceSlug,
      "ADMIN",
    );
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        {
          error: "Missing 'file' field in multipart form data",
          errorCode: "UPLOAD_FILE_MISSING",
        },
        { status: 400 },
      );
    }

    const document = await replaceDocumentFile({
      workspaceId,
      knowledgeBaseId,
      documentId,
      file,
    });
    await recordAudit({
      workspaceId,
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_REPLACE,
      target: { type: "document", id: document.id },
      metadata: {
        knowledge_base_id: knowledgeBaseId,
        title: document.title,
        mime_type: document.mimeType,
        version: document.version,
      },
    });
    return NextResponse.json({ document });
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
