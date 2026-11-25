import { NextResponse } from "next/server";

import { AUDIT_ACTIONS, recordAudit } from "@/lib/audit";
import { AuthzError, requireWorkspaceMemberBySlug } from "@/lib/authz";
import {
  type CreateEvaluationCaseParams,
  importEvaluationCases,
  MAX_IMPORT_CASES,
} from "@/lib/evaluation";

type RouteParams = {
  params: Promise<{ workspaceSlug: string; datasetId: string }>;
};

function toStringArrayOrNull(val: unknown): string[] | null {
  if (!Array.isArray(val)) return null;
  const cleaned = val
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return cleaned.length > 0 ? cleaned : null;
}

function parseImportedPayload(
  parsed: unknown,
):
  | { cases: CreateEvaluationCaseParams[] }
  | { errorCode: "EVALUATION_IMPORT_INVALID" | "EVALUATION_IMPORT_TOO_LARGE" } {
  const rawCases = Array.isArray(parsed)
    ? parsed
    : parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { cases?: unknown }).cases)
      ? (parsed as { cases: unknown[] }).cases
      : null;

  if (!rawCases || rawCases.length === 0) {
    return { errorCode: "EVALUATION_IMPORT_INVALID" };
  }
  if (rawCases.length > MAX_IMPORT_CASES) {
    return { errorCode: "EVALUATION_IMPORT_TOO_LARGE" };
  }

  const out: CreateEvaluationCaseParams[] = [];
  for (const item of rawCases) {
    if (!item || typeof item !== "object") {
      return { errorCode: "EVALUATION_IMPORT_INVALID" };
    }
    const rec = item as Record<string, unknown>;
    const question =
      typeof rec.question === "string" ? rec.question.trim() : "";
    if (!question) {
      return { errorCode: "EVALUATION_IMPORT_INVALID" };
    }
    out.push({
      question,
      expectedAnswer:
        typeof rec.expectedAnswer === "string" && rec.expectedAnswer.trim()
          ? rec.expectedAnswer.trim()
          : null,
      expectedSourceDocuments: toStringArrayOrNull(rec.expectedSourceDocuments),
      expectedChunks: toStringArrayOrNull(rec.expectedChunks),
      requiredFacts: toStringArrayOrNull(rec.requiredFacts),
      tags: toStringArrayOrNull(rec.tags),
    });
  }

  return { cases: out };
}

/** Bulk-import evaluation cases from a JSON file or JSON body (ADMIN+). */
export async function POST(request: Request, { params }: RouteParams) {
  const { workspaceSlug, datasetId } = await params;
  try {
    const { workspaceId, user } = await requireWorkspaceMemberBySlug(
      workspaceSlug,
      "ADMIN",
    );

    const contentType = request.headers.get("content-type") ?? "";
    let rawJsonText: string;
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return NextResponse.json(
          { error: "Missing JSON file", errorCode: "EVALUATION_IMPORT_INVALID" },
          { status: 400 },
        );
      }
      rawJsonText = await file.text();
    } else {
      rawJsonText = await request.text();
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawJsonText);
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON", errorCode: "EVALUATION_IMPORT_INVALID" },
        { status: 400 },
      );
    }

    const validated = parseImportedPayload(parsedJson);
    if ("errorCode" in validated) {
      return NextResponse.json(
        {
          error: validated.errorCode,
          errorCode: validated.errorCode,
          max: MAX_IMPORT_CASES,
        },
        { status: 400 },
      );
    }

    const imported = await importEvaluationCases(
      workspaceId,
      datasetId,
      validated.cases,
    );
    if (!imported) {
      return NextResponse.json(
        { error: "Dataset not found", errorCode: "DATASET_NOT_FOUND" },
        { status: 404 },
      );
    }

    await recordAudit({
      workspaceId,
      actorId: user.id,
      action: AUDIT_ACTIONS.EVALUATION_CASE_IMPORT,
      target: { type: "evaluation_dataset", id: datasetId },
      metadata: {
        dataset_id: datasetId,
        imported_count: imported.importedCount,
      },
    });

    return NextResponse.json(imported, { status: 201 });
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
