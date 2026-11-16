import { describe, it, expect } from "vitest";
import { getTestServer } from "./helpers/test-server";

// The (tenant_id, identifier) and (tenant_id, name) unique indexes have been
// in the kysely schema all along; these cover that the adapters surface a
// violation as a 409 on update as well as create.
describe("resource_servers unique (tenant_id, identifier)", () => {
  it("rejects a duplicate identifier on create and update with a 409", async () => {
    const { data } = await getTestServer();
    await data.resourceServers.create("t1", {
      name: "A",
      identifier: "https://a.example.com",
    });
    const b = await data.resourceServers.create("t1", {
      name: "B",
      identifier: "https://b.example.com",
    });

    await expect(
      data.resourceServers.create("t1", {
        name: "A copy",
        identifier: "https://a.example.com",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      data.resourceServers.update("t1", b.id!, {
        identifier: "https://a.example.com",
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      data.resourceServers.create("t2", {
        name: "A",
        identifier: "https://a.example.com",
      }),
    ).resolves.toMatchObject({ identifier: "https://a.example.com" });
  });
});

describe("organizations unique (tenant_id, name)", () => {
  it("rejects a duplicate name on create and update with a 409", async () => {
    const { data } = await getTestServer();
    await data.organizations.create("t1", { name: "acme" });
    const other = await data.organizations.create("t1", { name: "globex" });

    await expect(
      data.organizations.create("t1", { name: "acme" }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      data.organizations.update("t1", other.id, { name: "acme" }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      data.organizations.update("t1", other.id, { name: "globex" }),
    ).resolves.toBe(true);

    await expect(
      data.organizations.create("t2", { name: "acme" }),
    ).resolves.toMatchObject({ name: "acme" });
  });
});
