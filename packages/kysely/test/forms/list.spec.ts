import { describe, expect, it } from "vitest";
import { getTestServer } from "../helpers/test-server";

describe("forms", () => {
  describe("list", () => {
    it("should list a form with fields as a JSON object", async () => {
      const { data } = await getTestServer();

      await data.tenants.create({
        id: "tenantId",
        friendly_name: "Test Tenant",
        audience: "https://example.com",
        sender_email: "login@example.com",
        sender_name: "SenderName",
      });

      const form = await data.forms.create("tenantId", {
        name: "Basic Form",
      });

      const result = await data.forms.list("tenantId", {
        include_totals: true,
      });

      expect(result).toMatchObject({
        forms: [
          expect.objectContaining({
            id: form.id,
            name: "Basic Form",
          }),
        ],
        length: 1,
        limit: 50,
      });
    });

    it("searches names before pagination and preserves structured filters", async () => {
      const { data } = await getTestServer();
      for (const id of ["tenantId", "otherTenant"]) {
        await data.tenants.create({
          id,
          friendly_name: "Test Tenant",
          audience: "https://example.com",
          sender_email: "login@example.com",
          sender_name: "SenderName",
        });
      }
      await data.forms.create("tenantId", { name: "Registration Form" });
      await data.forms.create("tenantId", { name: "Registration Survey" });
      await data.forms.create("tenantId", { name: "Contact Form" });
      await data.forms.create("otherTenant", { name: "Registration Other" });
      const result = await data.forms.list("tenantId", {
        q: "Registration",
        per_page: 1,
        include_totals: true,
      });
      expect(result.forms).toHaveLength(1);
      expect(result.forms[0].name).toContain("Registration");
      expect(result.length).toBe(2);
      const structured = await data.forms.list("tenantId", {
        q: 'name:"Contact Form"',
      });
      expect(structured.forms.map((form) => form.name)).toEqual([
        "Contact Form",
      ]);
      expect(
        (await data.forms.list("tenantId", { q: "missing" })).forms,
      ).toEqual([]);
    });

    it("should list multiple forms", async () => {
      const { data } = await getTestServer();

      await data.tenants.create({
        id: "tenantId",
        friendly_name: "Test Tenant",
        audience: "https://example.com",
        sender_email: "login@example.com",
        sender_name: "SenderName",
      });

      const form1 = await data.forms.create("tenantId", {
        name: "Registration Form",
      });

      const form2 = await data.forms.create("tenantId", {
        name: "Contact Form",
      });

      const result = await data.forms.list("tenantId", {
        include_totals: true,
      });

      expect(result.forms).toHaveLength(2);
      expect(result.length).toBe(2);
      expect(result.forms.map((form) => form.id)).toContain(form1.id);
      expect(result.forms.map((form) => form.id)).toContain(form2.id);
    });
  });
});
