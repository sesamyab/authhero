import { useRecordContext } from "ra-core";
import { useWatch } from "react-hook-form";
import { getClientShape, type ClientShape } from "./shape";

// The shape of the client being edited, following unsaved grant_types and
// token_endpoint_auth_method edits so ticking Client Credentials reveals the
// Client Grants tab immediately.
// Must be called inside the edit form.
export function useClientShape(): ClientShape {
  const record = useRecordContext();
  const grantTypes: unknown = useWatch({ name: "grant_types" });
  const authMethod: unknown = useWatch({ name: "token_endpoint_auth_method" });
  return getClientShape({
    ...record,
    grant_types: Array.isArray(grantTypes) ? grantTypes : record?.grant_types,
    token_endpoint_auth_method:
      typeof authMethod === "string"
        ? authMethod
        : record?.token_endpoint_auth_method,
  });
}
