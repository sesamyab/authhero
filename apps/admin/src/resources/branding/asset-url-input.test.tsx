import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { FormProvider, useForm } from "react-hook-form";
import { AssetUrlInput } from "./asset-url-input";

const notify = vi.fn();
vi.mock("ra-core", () => ({ useNotify: () => notify }));
vi.mock("@/TenantContext", () => ({ useTenantId: () => "t1" }));
vi.mock("@/components/admin", async () => {
  const { useFormContext } = await import("react-hook-form");
  return {
    TextInput: ({ source }: { source: string }) => {
      const { register } = useFormContext();
      return <input data-testid="url" {...register(source)} />;
    },
  };
});

const resolvers: ((url: string) => void)[] = [];
let resolveUpload: (url: string) => void = () => {};
let rejectUpload: (err: Error) => void = () => {};
vi.mock("./previewClient", () => ({
  getApiUrl: () => "http://api",
  getHttpClient: () => () =>
    new Promise((resolve, reject) => {
      resolveUpload = (url) => resolve({ json: { url } });
      resolvers.push(resolveUpload);
      rejectUpload = reject;
    }),
}));

let form: ReturnType<typeof useForm>;
function Harness({ show = true }: { show?: boolean }) {
  form = useForm<Record<string, unknown>>({
    defaultValues: { logo_url: "old" },
  });
  return (
    <FormProvider {...form}>
      {show && <AssetUrlInput source="logo_url" label="Logo" kind="logo" />}
    </FormProvider>
  );
}

const png = () =>
  new File([new Uint8Array([1])], "a.png", { type: "image/png" });
const pick = (container: HTMLElement) =>
  fireEvent.change(container.querySelector('input[type="file"]')!, {
    target: { files: [png()] },
  });

afterEach(() => {
  cleanup();
  resolvers.length = 0;
  notify.mockClear();
});

describe("AssetUrlInput", () => {
  it("applies the uploaded URL and clears the submit guard afterwards", async () => {
    const { container } = render(<Harness />);
    pick(container);
    await act(async () => {
      expect(await form.trigger()).toBe(false); // blocked while pending
      resolveUpload("http://a/new.png");
    });
    await waitFor(() =>
      expect(form.getValues("logo_url")).toBe("http://a/new.png"),
    );
    expect(await form.trigger()).toBe(true);
  });

  it("does not overwrite an edit made during the upload, even restoring the original", async () => {
    const { container } = render(<Harness />);
    pick(container);
    await act(async () => {
      form.setValue("logo_url", "typed");
      form.setValue("logo_url", "old"); // restored to the original value
      resolveUpload("http://a/new.png");
    });
    await waitFor(() => expect(form.formState).toBeDefined());
    expect(form.getValues("logo_url")).toBe("old");
  });

  it("discards an upload that finishes after the input unmounted", async () => {
    const { container, rerender } = render(<Harness />);
    pick(container);
    rerender(<Harness show={false} />);
    await act(async () => resolveUpload("http://a/new.png"));
    expect(form.getValues("logo_url")).toBe("old");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("discarded"),
      expect.anything(),
    );
  });

  it("re-enables submit and keeps the value when the upload fails", async () => {
    const { container } = render(<Harness />);
    pick(container);
    await act(async () => rejectUpload(new Error("boom")));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith("boom", { type: "error" }),
    );
    expect(form.getValues("logo_url")).toBe("old");
    expect(await form.trigger()).toBe(true);
  });

  it.each([
    ["first finishes first", [0, 1]],
    ["second finishes first", [1, 0]],
  ])(
    "only the latest of two overlapping uploads wins (%s)",
    async (_n, order) => {
      const { container } = render(<Harness />);
      pick(container);
      pick(container);
      await act(async () => {
        for (const i of order) resolvers[i]!(`http://a/${i}.png`);
      });
      await waitFor(() =>
        expect(form.getValues("logo_url")).toBe("http://a/1.png"),
      );
    },
  );

  it("discards an upload started before a remount and warns", async () => {
    const { container, rerender } = render(<Harness />);
    pick(container);
    rerender(<Harness show={false} />);
    rerender(<Harness show />);
    await act(async () => {
      resolvers[0]!("http://a/0.png");
    });
    expect(form.getValues("logo_url")).toBe("old");
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("discarded"),
      expect.anything(),
    );
  });
});
