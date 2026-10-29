import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CoreAdminContext, TestMemoryRouter, testDataProvider } from "ra-core";
import type { TeamRequestRecord } from "../../auth0DataProvider";
import { describeTeamRequest, visibleTeamRequests } from "./TeamRequestsCard";
import { TeamPage } from "./TeamPage";
import { memberInitials, memberLabel } from "./memberDisplay";

beforeAll(() => {
  // Radix (the tooltip) measures with these; jsdom has neither.
  globalThis.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const request = (
  patch: Partial<TeamRequestRecord> & { id: string },
): TeamRequestRecord => ({
  kind: "invite",
  status: "pending",
  requested_by: "auth0|admin",
  payload: { invitee: { email: "new@example.com" } },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...patch,
});

describe("describeTeamRequest", () => {
  it.each([
    [{ kind: "invite" as const }, "Invite new@example.com"],
    [
      { kind: "add_members" as const, payload: { user_ids: ["a"] } },
      "Add 1 member",
    ],
    [
      { kind: "remove_members" as const, payload: { user_ids: ["a", "b"] } },
      "Remove 2 members",
    ],
    [
      {
        kind: "assign_roles" as const,
        payload: { user_id: "u1", roles: ["r1", "r2"] },
      },
      "Give 2 roles to u1",
    ],
    [
      {
        kind: "remove_roles" as const,
        payload: { user_id: "u1", roles: ["r1"] },
      },
      "Take 1 role from u1",
    ],
    [
      { kind: "revoke_invitation" as const, payload: {} },
      "Revoke an invitation",
    ],
  ])("describes %j", (patch, text) => {
    expect(describeTeamRequest(request({ id: "x", ...patch }))).toBe(text);
  });
});

describe("memberInitials and memberLabel", () => {
  const member = (patch: Record<string, unknown>) =>
    ({ user_id: "auth0|77c0", roles: [], ...patch }) as never;

  it.each([
    [{ name: "Ada Lovelace" }, "AL"],
    [{ name: "Ada King Lovelace" }, "AL"],
    [{ name: "admin" }, "A"],
    [{ email: "new.colleague@example.com" }, "N"],
    [{ name: "  ", email: "sam@example.com" }, "S"],
    [{}, "?"],
  ])("takes the initials of %j", (patch, initials) => {
    expect(memberInitials(member(patch))).toBe(initials);
  });

  it("labels by name, then address, then id", () => {
    expect(memberLabel(member({ name: "Ada", email: "a@x.com" }))).toBe("Ada");
    expect(memberLabel(member({ email: "a@x.com" }))).toBe("a@x.com");
    expect(memberLabel(member({}))).toBe("auth0|77c0");
  });
});

describe("visibleTeamRequests", () => {
  const now = Date.parse("2026-01-01T12:00:00.000Z");

  it("keeps waiting and failed requests, and recent successes only", () => {
    const shown = visibleTeamRequests(
      [
        request({ id: "pending" }),
        request({ id: "failed", status: "failed" }),
        request({
          id: "fresh",
          status: "succeeded",
          finished_at: "2026-01-01T11:30:00.000Z",
        }),
        request({
          id: "old",
          status: "succeeded",
          finished_at: "2026-01-01T09:00:00.000Z",
        }),
      ],
      now,
    );

    expect(shown.map((r) => r.id)).toEqual(["pending", "failed", "fresh"]);
  });
});

describe("TeamPage", () => {
  let requests: TeamRequestRecord[];
  let listTeamMembers: ReturnType<typeof vi.fn>;
  let createTeamInvitation: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requests = [];
    listTeamMembers = vi.fn(async () => ({
      members: [],
      start: 0,
      limit: 100,
      total: 0,
    }));
    createTeamInvitation = vi.fn(async () => ({
      requested: true,
      id: "tmr_1",
      status: "pending",
    }));
  });

  function renderPage(overrides: Record<string, unknown> = {}) {
    const dataProvider = testDataProvider({
      listTeamMembers,
      listTeamInvitations: vi.fn(async () => []),
      listAssignableTeamRoles: vi.fn(async () => []),
      listTeamRequests: vi.fn(async () => requests),
      createTeamInvitation,
      ...overrides,
    });
    return render(
      <TestMemoryRouter>
        <CoreAdminContext dataProvider={dataProvider}>
          <TeamPage />
        </CoreAdminContext>
      </TestMemoryRouter>,
    );
  }

  it("shows what is waiting, and a failure with its reason", async () => {
    requests = [
      request({ id: "a" }),
      request({
        id: "b",
        kind: "remove_members",
        payload: { user_ids: ["u1"] },
        status: "failed",
        error: "The requester is no longer an administrator of this tenant",
      }),
    ];

    renderPage();

    await waitFor(() =>
      expect(screen.getByTestId("team-requests")).toBeTruthy(),
    );
    expect(screen.getByText("Invite new@example.com")).toBeTruthy();
    expect(screen.getByText("Waiting")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    // The reason sits behind an error icon, readable by its label and on hover.
    const icon = screen.getByLabelText(
      /Why it failed: .*no longer an administrator/,
    );
    expect(screen.queryByText(/no longer an administrator/)).toBeNull();
    fireEvent.focus(icon);
    expect(
      (await screen.findAllByText(/no longer an administrator/)).length,
    ).toBeGreaterThan(0);
  });

  it("shows nothing extra against a server without requests", async () => {
    renderPage({
      listTeamRequests: vi.fn(async () => {
        throw new Error("501");
      }),
    });

    await waitFor(() =>
      expect(
        screen.getByText("No team members yet. Invite someone to get started."),
      ).toBeTruthy(),
    );
    expect(screen.queryByTestId("team-requests")).toBeNull();
  });

  it("looks again while a request is waiting, and stops when none is", async () => {
    vi.useFakeTimers();
    requests = [request({ id: "a" })];
    renderPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const first = listTeamMembers.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(listTeamMembers.mock.calls.length).toBeGreaterThan(first);

    requests = [
      request({
        id: "a",
        status: "succeeded",
        finished_at: new Date().toISOString(),
      }),
    ];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    const settled = listTeamMembers.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(listTeamMembers.mock.calls.length).toBe(settled);
  });

  it("sends an invitation as a request and says so", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Invite member")).toBeTruthy());

    fireEvent.click(screen.getByText("Invite member"));
    fireEvent.change(
      await screen.findByPlaceholderText("colleague@example.com"),
      {
        target: { value: "new@example.com" },
      },
    );
    fireEvent.click(screen.getByText("Send invitation"));

    await waitFor(() => expect(createTeamInvitation).toHaveBeenCalled());
    expect(createTeamInvitation.mock.calls[0]![0]).toMatchObject({
      email: "new@example.com",
    });
  });
});
