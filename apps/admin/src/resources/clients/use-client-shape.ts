import { useRecordContext } from "ra-core";
import { useWatch } from "react-hook-form";
import { getClientShape, type ClientShape } from "./shape";

// The shape of the client being edited, following unsaved grant_types edits
// so ticking Client Credentials reveals the Client Grants tab immediately.
// Must be called inside the edit form.
export function useClientShape(): ClientShape {
  const record = useRecordContext();
  const grantTypes: unknown = useWatch({ name: "grant_types" });
  return getClientShape({
    ...record,
    grant_types: Array.isArray(grantTypes) ? grantTypes : record?.grant_types,
  });
}
