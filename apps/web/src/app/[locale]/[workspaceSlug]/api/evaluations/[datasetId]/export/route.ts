import { NextResponse } from "next/server";

import { AuthzError, requireWorkspaceMemberBySlug } from "@/lib/authz";
import { getEvaluationDataset, listEvaluationCases } from "@/lib/evaluation";

type RouteParams = {
  params: Promise<{ workspaceSlug: string; datasetId: string }>;
};

function safeFilenameSlug(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "dataset";
}

/** Export an evaluation dataset's cases as a structured JSON file (MEMBER+). */
export async function GET(_request: Request, { params }: RouteParams) {
  const { workspaceSlug, datasetId } = await params;
  try {
    const { workspaceId } = await requireWorkspaceMemberBySlug(workspaceSlug);
    const dataset = await getEvaluationDataset(workspaceId, datasetId);
    if (!dataset) {
      return NextResponse.json(
        { error: "Dataset not found", errorCode: "DATASET_NOT_FOUND" },
        { status: 404 },
      );
    }

    const cases = await listEvaluationCases(workspaceId, datasetId);
    const payload = {
      version: 1,
      datasetName: dataset.name,
      description: dataset.description,
      knowledgeBaseId: dataset.knowledgeBaseId,
      exportedAt: new Date().toISOString(),
      cases: cases.map((c) => ({
        question: c.question,
        expectedAnswer: c.expectedAnswer ?? null,
        expectedSourceDocuments: c.expectedSourceDocuments ?? null,
        expectedChunks: c.expectedChunks ?? null,
        requiredFacts: c.requiredFacts ?? null,
        tags: c.tags ?? null,
      })),
    };

    const filename = `${safeFilenameSlug(dataset.name)}-cases.json`;
    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    });
  } catch (error) {
    if (error instanceof AuthzError) {
      return NextResponse.json(
        { error: error.message, errorCode: "AUTHORIZATION_FAILED" },
        { status: error.status },
      );
    }
    throw error;
  }
}
