import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { ActionAssistant } from "./action-assistant";
import { actionRequest } from "./api";

vi.mock("./api", () => ({ actionRequest: vi.fn() }));
vi.mock("@/TenantContext", () => ({ useTenantId: () => "tenant" }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function Harness() {
  const form = useForm({
    defaultValues: {
      code: "original source",
      trigger_id: "post-login",
      inherit: false,
    },
  });
  const code = useWatch({ control: form.control, name: "code" });
  return (
    <FormProvider {...form}>
      <ActionAssistant />
      <output aria-label="Current source">{code}</output>
      <button onClick={() => form.setValue("code", "edited source")}>
        Edit source
      </button>
      <button
        onClick={() => form.setValue("trigger_id", "pre-user-registration")}
      >
        Change trigger
      </button>
    </FormProvider>
  );
}

describe("Action assistant", () => {
  it("previews generated code and only replaces the editor when accepted", async () => {
    vi.mocked(actionRequest).mockImplementation(async (_tenant, path) =>
      path === "generation"
        ? { models: ["glm", "deepseek", "qwen"] }
        : { code: "generated source" },
    );
    render(<Harness />);
    fireEvent.change(await screen.findByLabelText("Describe your action"), {
      target: { value: "Add a role" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate draft" }));
    const accept = await screen.findByRole("button", {
      name: "Use generated code",
    });
    expect(screen.getByLabelText("Current source").textContent).toBe(
      "original source",
    );
    expect(actionRequest).toHaveBeenCalledWith("tenant", "generate", {
      model: "glm",
      prompt: "Add a role",
      trigger_id: "post-login",
    });
    fireEvent.click(accept);
    expect(screen.getByLabelText("Current source").textContent).toBe(
      "generated source",
    );
  });
  it("invalidates a passed verification when the source or trigger changes", async () => {
    vi.mocked(actionRequest).mockImplementation(async (_tenant, path) =>
      path === "generation" ? { models: [] } : { valid: true, errors: [] },
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    await screen.findByText("Verification passed");
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    expect(screen.queryByText("Verification passed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    await screen.findByText("Verification passed");
    fireEvent.click(screen.getByRole("button", { name: "Change trigger" }));
    expect(screen.queryByText("Verification passed")).toBeNull();
  });
  it("shows actionable errors when verification fails", async () => {
    vi.mocked(actionRequest).mockImplementation(async (_tenant, path) =>
      path === "generation"
        ? { models: [] }
        : { valid: false, errors: ["Define the trigger handler."] },
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Verify code" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Define the trigger handler.",
      ),
    );
  });
});
