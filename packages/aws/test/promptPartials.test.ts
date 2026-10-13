import { afterEach, describe, expect, it } from "vitest";
import { getTestServer, teardownTestServer } from "./helpers/test-server";

describe("promptPartials", () => {
  afterEach(async () => {
    await teardownTestServer();
  });

  it("sets, replaces, lists, and deletes tenant-scoped partials", async () => {
    const { data } = await getTestServer();

    expect(await data.promptPartials.get("tenantId", "signup")).toBeNull();

    await data.promptPartials.set("tenantId", "signup", {
      signup: {
        "form-content-start": "<p>First</p>",
        "form-content-end": "<p>Removed on replace</p>",
      },
    });
    await data.promptPartials.set("tenantId", "signup", {
      signup: { "form-footer-end": "<p>Replacement</p>" },
    });

    expect(await data.promptPartials.get("tenantId", "signup")).toEqual({
      signup: { "form-footer-end": "<p>Replacement</p>" },
    });
    expect(await data.promptPartials.list("tenantId")).toEqual(["signup"]);

    await data.promptPartials.delete("tenantId", "signup");
    expect(await data.promptPartials.get("tenantId", "signup")).toBeNull();
  });
});
