import type { DataProvider } from "ra-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { CoreAdminContext, TestMemoryRouter, testDataProvider } from "ra-core";
import { ActionTriggersList } from "./list";
import type { TriggerBinding } from "./bindings";

afterEach(cleanup);

const bindings: TriggerBinding[] = [
  {
    id: "h_action",
    hook_id: "h_action",
    trigger_id: "post-user-login",
    code_id: "act_1",
    enabled: true,
    priority: 1,
  },
  {
    id: "h_second",
    trigger_id: "post-user-login",
    code_id: "act_2",
    enabled: true,
    priority: 1,
  },
  {
    id: "h_webhook",
    trigger_id: "post-user-login",
    url: "https://example.com/hook",
    enabled: false,
  },
  {
    id: "h_form",
    trigger_id: "post-user-login",
    form_id: "form_1",
    enabled: true,
  },
  {
    id: "h_template",
    trigger_id: "post-user-login",
    template_id: "account-linking",
    enabled: true,
  },
  {
    id: "h_page",
    trigger_id: "post-user-login",
    page_id: "impersonate",
    permission_required: "users:impersonate",
    enabled: true,
  },
  {
    id: "h_legacy",
    trigger_id: "legacy-trigger",
    url: "https://example.com/legacy",
    enabled: false,
  },
  {
    id: "h_sy0123456789abcde",
    trigger_id: "pre-user-registration",
    code_id: "act_1",
    enabled: true,
    override: "none",
  },
];

function setup(overrides: Record<string, unknown> = {}) {
  const update = vi.fn(async (_resource, { id, data }) => ({
    data: { id, ...data },
  }));
  const remove = vi.fn(async (_resource, { id }) => ({ data: { id } }));
  const getList = vi.fn(async (resource: string) => {
    const data =
      resource === "hooks"
        ? bindings
        : resource === "actions"
          ? [
              {
                id: "act_1",
                name: "Check access",
                supported_triggers: [{ id: "post-login" }],
              },
              {
                id: "act_2",
                name: "Add claims",
                supported_triggers: [{ id: "post-login" }],
              },
            ]
          : [{ id: "form_1", name: "Complete profile" }];
    return { data, total: data.length };
  });
  const dataProvider = testDataProvider({
    getList: getList as DataProvider["getList"],
    update,
    delete: remove as DataProvider["delete"],
    ...overrides,
  });
  render(
    <TestMemoryRouter>
      <CoreAdminContext dataProvider={dataProvider}>
        <ActionTriggersList />
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
  return { update, remove, getList };
}

describe("unified Triggers", () => {
  it("shows all five binding types, named targets and old triggers", async () => {
    setup();
    const actions = await screen.findByRole("region", {
      name: "Post User Login Actions",
    });
    expect(within(actions).getByText("Check access")).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Post User Login Webhooks" }),
    ).toBeTruthy();
    expect(screen.getByText("Complete profile")).toBeTruthy();
    expect(screen.getByText("Account Linking")).toBeTruthy();
    expect(screen.getByText("Impersonate")).toBeTruthy();
    expect(screen.getByText("Requires users:impersonate")).toBeTruthy();
    expect(screen.getByText("https://example.com/legacy")).toBeTruthy();
    expect(
      within(actions).getAllByText("Edit action code")[0].getAttribute("href"),
    ).toBe("/actions/act_1");
    const add = screen.getByRole("link", {
      name: "Add binding to Validate Registration Username",
    });
    const source = new URL(
      add.getAttribute("href")!,
      "http://localhost",
    ).searchParams.get("source");
    expect(JSON.parse(source!)).toEqual({
      trigger_id: "validate-registration-username",
      type: "code",
    });
  });

  it("updates and removes the original binding rows for any type", async () => {
    const { update, remove } = setup();
    const enable = await screen.findByRole("switch", {
      name: "Enable https://example.com/hook",
    });
    fireEvent.click(enable);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        "hooks",
        expect.objectContaining({ id: "h_webhook", data: { enabled: true } }),
      ),
    );
    const unbind = screen.getByRole("button", {
      name: "Remove Complete profile binding",
    });
    await waitFor(() => expect(unbind.hasAttribute("disabled")).toBe(false));
    fireEvent.click(unbind);
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith(
        "hooks",
        expect.objectContaining({ id: "h_form" }),
      ),
    );
  });

  it("moves equal-priority Actions down without crossing binding types", async () => {
    const { update } = setup();
    const section = await screen.findByRole("region", {
      name: "Post User Login Actions",
    });
    fireEvent.click(
      within(section).getByRole("button", { name: "Move Check access down" }),
    );
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[0]).toEqual([
      "hooks",
      expect.objectContaining({ id: "h_action", data: { priority: 0 } }),
    ]);
    expect(update.mock.calls[1]).toEqual([
      "hooks",
      expect.objectContaining({ id: "h_second", data: { priority: 1 } }),
    ]);
    expect(
      screen
        .getByRole("button", { name: "Move https://example.com/hook up" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps inherited locked bindings visible while disabling mutations", async () => {
    setup();
    const section = await screen.findByRole("region", {
      name: "Pre User Registration Actions",
    });
    expect(within(section).getByText("inherited")).toBeTruthy();
    expect(within(section).getByRole("switch").hasAttribute("disabled")).toBe(
      true,
    );
    expect(
      within(section)
        .getByRole("button", { name: "Remove Check access binding" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(section)
        .getByRole("link", { name: "Edit Check access binding" })
        .getAttribute("href"),
    ).toBe("/hooks/h_sy0123456789abcde");
  });
});
