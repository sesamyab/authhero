import { describe, expect, it } from "vitest";
import { MANAGEMENT_API_SCOPES } from "authhero";
import {
  OPERATOR_ONLY_SCOPES,
  tenantOwnerScopes,
} from "../src/hooks/tenant-roles";

describe("the tenant owner role's scopes", () => {
  it("never contains an operator-only scope, and each of those is a real scope", () => {
    const all = MANAGEMENT_API_SCOPES.map((scope) => scope.value);
    const owner = tenantOwnerScopes();
    for (const scope of OPERATOR_ONLY_SCOPES) {
      expect(all, `${scope} is not a management scope`).toContain(scope);
      expect(owner).not.toContain(scope);
    }
    expect(owner.length).toBe(all.length - OPERATOR_ONLY_SCOPES.length);
  });

  // Frozen on purpose. A management scope that is added later reaches every
  // self-service customer unless it is listed as operator-only, so this fails
  // until someone decides which side the new scope belongs on: either add it to
  // OPERATOR_ONLY_SCOPES, or update the snapshot to accept it for owners.
  it("matches the frozen list", () => {
    expect([...tenantOwnerScopes()].sort()).toMatchSnapshot();
  });
});
