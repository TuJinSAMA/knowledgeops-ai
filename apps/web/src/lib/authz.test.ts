import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks --------------------------------------------------------------
// getServerSession is mocked so we can simulate authenticated / anonymous
// callers without a real better-auth session.
const getServerSessionMock = vi.fn();
vi.mock("@/lib/session", () => ({
  getServerSession: () => getServerSessionMock(),
}));

// db is mocked with a chainable query builder that resolves to whatever rows
// the current test configured. This lets us simulate membership / non-membership
// without touching Postgres.
let membershipRows: Array<Record<string, unknown>> = [];
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(membershipRows),
        }),
      }),
    }),
  },
}));

import { AuthzError, hasMinRole, requireWorkspaceMember } from "@/lib/authz";

const WORKSPACE_ID = "ws-1";
const USER = { id: "user-1", name: "Ada", email: "ada@example.com" };

beforeEach(() => {
  getServerSessionMock.mockReset();
  membershipRows = [];
});

describe("hasMinRole", () => {
  it("treats higher roles as satisfying lower requirements", () => {
    expect(hasMinRole("OWNER", "ADMIN")).toBe(true);
    expect(hasMinRole("OWNER", "MEMBER")).toBe(true);
    expect(hasMinRole("ADMIN", "MEMBER")).toBe(true);
    expect(hasMinRole("MEMBER", "MEMBER")).toBe(true);
  });

  it("rejects roles below the requirement", () => {
    expect(hasMinRole("MEMBER", "ADMIN")).toBe(false);
    expect(hasMinRole("ADMIN", "OWNER")).toBe(false);
    expect(hasMinRole("MEMBER", "OWNER")).toBe(false);
  });
});

describe("requireWorkspaceMember", () => {
  it("rejects unauthenticated callers with 401", async () => {
    getServerSessionMock.mockResolvedValue(null);

    await expect(requireWorkspaceMember(WORKSPACE_ID)).rejects.toMatchObject({
      status: 401,
    });
    await expect(requireWorkspaceMember(WORKSPACE_ID)).rejects.toBeInstanceOf(
      AuthzError,
    );
  });

  it("rejects non-members with 403 (tenant isolation)", async () => {
    getServerSessionMock.mockResolvedValue({ user: USER });
    membershipRows = []; // user has no membership in this workspace

    await expect(requireWorkspaceMember(WORKSPACE_ID)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("allows a member that meets the minimum role", async () => {
    getServerSessionMock.mockResolvedValue({ user: USER });
    membershipRows = [
      { id: "m-1", workspaceId: WORKSPACE_ID, userId: USER.id, role: "MEMBER" },
    ];

    const ctx = await requireWorkspaceMember(WORKSPACE_ID, "MEMBER");
    expect(ctx.role).toBe("MEMBER");
    expect(ctx.user.id).toBe(USER.id);
    expect(ctx.membership.workspaceId).toBe(WORKSPACE_ID);
  });

  it("rejects a member whose role is below the requirement with 403", async () => {
    getServerSessionMock.mockResolvedValue({ user: USER });
    membershipRows = [
      { id: "m-1", workspaceId: WORKSPACE_ID, userId: USER.id, role: "MEMBER" },
    ];

    await expect(
      requireWorkspaceMember(WORKSPACE_ID, "ADMIN"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("allows a higher role to satisfy a lower requirement", async () => {
    getServerSessionMock.mockResolvedValue({ user: USER });
    membershipRows = [
      { id: "m-1", workspaceId: WORKSPACE_ID, userId: USER.id, role: "OWNER" },
    ];

    const ctx = await requireWorkspaceMember(WORKSPACE_ID, "ADMIN");
    expect(ctx.role).toBe("OWNER");
  });
});
