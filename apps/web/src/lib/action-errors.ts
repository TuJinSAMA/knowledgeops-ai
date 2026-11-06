import { getLocale } from "next-intl/server";

export type ActionErrorCode =
  | "AUTHORIZATION_FAILED"
  | "WORKSPACE_NAME_REQUIRED"
  | "KNOWLEDGE_BASE_NAME_REQUIRED"
  | "KNOWLEDGE_BASE_NOT_FOUND"
  | "DATASET_NAME_REQUIRED"
  | "DATASET_NOT_FOUND"
  | "EVALUATION_CASE_QUESTION_REQUIRED"
  | "EVALUATION_CASE_NOT_FOUND"
  | "EVALUATION_CREATE_FAILED"
  | "EVALUATION_CASE_CREATE_FAILED"
  | "FEEDBACK_MESSAGE_REQUIRED"
  | "FEEDBACK_RATING_INVALID"
  | "FEEDBACK_REPORT_TYPE_INVALID"
  | "FEEDBACK_COMMENT_TOO_LONG"
  | "FEEDBACK_ANSWER_NOT_FOUND"
  | "FEEDBACK_REVIEW_STATUS_INVALID"
  | "FEEDBACK_NOT_FOUND"
  | "FEEDBACK_ALREADY_PROMOTED"
  | "UPLOAD_FILE_MISSING"
  | "UPLOAD_UNSUPPORTED_TYPE"
  | "UPLOAD_FILE_EMPTY"
  | "UPLOAD_FILE_TOO_LARGE";

export type ActionState = {
  errorCode?: ActionErrorCode;
  errorParams?: Record<string, string | number>;
};

/**
 * Prefix a path with the active request locale (e.g. `/zh/acme/knowledge-bases`)
 * when running inside a Next.js request context, or return `path` unchanged
 * when called from unit tests outside a request context.
 */
export async function withLocalePath(path: string): Promise<string> {
  try {
    const locale = await getLocale();
    if (locale && !path.startsWith(`/${locale}/`) && path !== `/${locale}`) {
      return `/${locale}${path.startsWith("/") ? path : `/${path}`}`;
    }
  } catch {
    // Outside a Next.js request context (e.g. unit tests): keep bare path.
  }
  return path;
}
