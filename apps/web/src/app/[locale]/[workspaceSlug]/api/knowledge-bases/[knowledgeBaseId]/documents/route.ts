import { NextResponse } from "next/server";

import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { AuthzError, requireWorkspaceMemberBySlug } from "@/lib/authz";
import { ingestUploadedFile, UploadError } from "@/lib/document-upload";
import { getKnowledgeBase, listDocuments } from "@/lib/knowledge-base";

type RouteParams = {
  params: Promise<{ workspaceSlug: string; knowledgeBaseId: string }>;
};

/** List documents in a knowledge base (used by the status-polling UI). */
export async function GET(_request: Request, { params }: RouteParams) {
  const { workspaceSlug, knowledgeBaseId } = await params;
  try {
    const { workspaceId } = await requireWorkspaceMemberBySlug(workspaceSlug);
    const kb = await getKnowledgeBase(workspaceId, knowledgeBaseId);
    if (!kb) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const documents = await listDocuments(workspaceId, knowledgeBaseId);
    return NextResponse.json({ documents });
  } catch (error) {
    if (error instanceof AuthzError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}

/** Upload a source document into a knowledge base (multipart/form-data). */
export async function POST(request: Request, { params }: RouteParams) {
  const { workspaceSlug, knowledgeBaseId } = await params;
  try {
    // Upload mutates the knowledge base, so require ADMIN or higher.
    const { workspaceId, user } = await requireWorkspaceMemberBySlug(
      workspaceSlug,
      "ADMIN",
    );

    const kb = await getKnowledgeBase(workspaceId, knowledgeBaseId);
    if (!kb) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

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

    const document = await ingestUploadedFile({
      workspaceId,
      knowledgeBaseId,
      file,
    });
    await recordAudit({
      workspaceId,
      actorId: user.id,
      action: AUDIT_ACTIONS.DOCUMENT_UPLOAD,
      target: { type: "document", id: document.id },
      metadata: {
        knowledge_base_id: knowledgeBaseId,
        title: document.title,
        mime_type: document.mimeType,
      },
    });
    return NextResponse.json({ document }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthzError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
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
