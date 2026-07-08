import { type ChatRequestBody, handleChat } from "@/lib/chat";

type RouteParams = {
  params: Promise<{ workspaceSlug: string }>;
};

// Streamed answer; never cache.
export const dynamic = "force-dynamic";

/**
 * Ask the assistant a question. Proxies the AI service SSE answer stream to the
 * browser after enforcing auth/tenant/role + quota and persisting the turn.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const { workspaceSlug } = await params;

  let body: ChatRequestBody;
  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  return handleChat(workspaceSlug, body);
}
