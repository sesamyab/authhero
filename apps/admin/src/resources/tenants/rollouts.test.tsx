import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CoreAdminContext, TestMemoryRouter, testDataProvider } from "ra-core";
import { Rollouts } from "./rollouts";

afterEach(cleanup);

beforeAll(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

function renderRollouts(overrides: Record<string, unknown> = {}) {
  const createRollout = vi.fn(() => Promise.resolve({ id: "r1" }));
  const dataProvider = testDataProvider({
    getList: vi.fn(() =>
      Promise.resolve({
        data: [
          { id: "acme" },
          { id: "acme-eu", parent_tenant_id: "acme" },
          { id: "solo" },
        ],
        total: 3,
      }),
    ) as never,
    listRollouts: vi.fn(() => Promise.resolve({ rollouts: [] })),
    getRollout: vi.fn(() => Promise.resolve({ id: "r1", summary: {} })),
    createRollout,
    ...overrides,
  });
  render(
    <TestMemoryRouter>
      <CoreAdminContext dataProvider={dataProvider}>
        <Rollouts />
      </CoreAdminContext>
    </TestMemoryRouter>,
  );
  return { createRollout };
}

const waveInputs = () =>
  screen.getAllByLabelText(/^Wave \d+$/) as HTMLInputElement[];

describe("Rollouts form", () => {
  it("starts with the default waves and sends them as numbers", async () => {
    const { createRollout } = renderRollouts();
    await waitFor(() => expect(waveInputs()).toHaveLength(3));
    expect(waveInputs().map((i) => i.value)).toEqual(["10", "50", "100"]);

    fireEvent.click(screen.getByText("Start rollout"));

    await waitFor(() =>
      expect(createRollout).toHaveBeenCalledWith({
        canary: 1,
        waves: [10, 50, 100],
        failure_threshold: 0.1,
      }),
    );
  });

  it("adds and removes waves, and keeps at least one", async () => {
    renderRollouts();
    await waitFor(() => expect(waveInputs()).toHaveLength(3));

    fireEvent.click(screen.getByText("Add wave"));
    expect(waveInputs()).toHaveLength(4);

    fireEvent.click(screen.getByLabelText("Remove wave 4"));
    fireEvent.click(screen.getByLabelText("Remove wave 3"));
    fireEvent.click(screen.getByLabelText("Remove wave 2"));
    expect(waveInputs()).toHaveLength(1);
    expect(
      (screen.getByLabelText("Remove wave 1") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("says what is wrong and does not start with a bad wave", async () => {
    const { createRollout } = renderRollouts();
    await waitFor(() => expect(waveInputs()).toHaveLength(3));

    fireEvent.change(waveInputs()[2]!, { target: { value: "20" } });

    expect(screen.getByText(/Waves must be ascending/)).toBeTruthy();
    expect(
      (screen.getByText("Start rollout") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByText("Start rollout"));
    expect(createRollout).not.toHaveBeenCalled();
  });
});
