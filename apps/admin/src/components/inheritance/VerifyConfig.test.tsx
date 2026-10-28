import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CoreAdminContext, TestMemoryRouter, testDataProvider } from "ra-core";
import { VerifyConfig } from "./VerifyConfig";

afterEach(cleanup);

function renderWith(verifyConfigSync: () => Promise<unknown>) {
  return render(
    <TestMemoryRouter>
      <CoreAdminContext
        dataProvider={testDataProvider({
          verifyConfigSync: vi.fn(verifyConfigSync),
        })}
      >
        <VerifyConfig tenantId="acme" />
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
}

const verification = {
  tenant_id: "acme",
  config_sync: "synced",
  method: "sync-dry-run",
  differences: [] as unknown[],
  errors: [] as string[],
};

describe("VerifyConfig", () => {
  it("shows nothing until it is asked", () => {
    renderWith(async () => ({ ...verification, ok: true }));

    expect(screen.queryByText("Matches")).toBeNull();
    expect(screen.getByText("Verify")).toBeTruthy();
  });

  it("says the config matches on a pass", async () => {
    renderWith(async () => ({ ...verification, ok: true }));

    fireEvent.click(screen.getByText("Verify"));

    expect(await screen.findByText("Matches")).toBeTruthy();
  });

  it("lists the differences and errors on a failure", async () => {
    renderWith(async () => ({
      ...verification,
      ok: false,
      differences: [
        { entity: "action", key: "enrich", kind: "missing" },
        {
          entity: "connection",
          key: "google-oauth2:google",
          kind: "changed",
          fields: ["options"],
        },
      ],
      errors: ["hook h_1: boom"],
    }));

    fireEvent.click(screen.getByText("Verify"));

    expect(await screen.findByText("3 problem(s)")).toBeTruthy();
    expect(screen.getByText("missing")).toBeTruthy();
    expect(screen.getByText("enrich")).toBeTruthy();
    expect(screen.getByText("(options)")).toBeTruthy();
    expect(screen.getByText("hook h_1: boom")).toBeTruthy();
  });

  it("does not leave an earlier pass on screen when a later check fails", async () => {
    const results = [
      () => Promise.resolve({ ...verification, ok: true }),
      () => Promise.reject(new Error("tenant worker unreachable")),
    ];
    renderWith(() => results.shift()!());

    fireEvent.click(screen.getByText("Verify"));
    expect(await screen.findByText("Matches")).toBeTruthy();

    fireEvent.click(screen.getByText("Verify"));
    await waitFor(() => expect(screen.queryByText("Matches")).toBeNull());
  });
});
