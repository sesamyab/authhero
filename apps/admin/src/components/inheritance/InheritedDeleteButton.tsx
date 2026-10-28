import { DeleteButton } from "@/components/admin/delete-button";
import { useInheritedRow } from "./InheritedFieldset";

/**
 * The Delete button of an edit page, left out for a row copied from a parent
 * that is enforced: the server refuses to delete it (`protect-synced`), so the
 * button would only lead to an error.
 */
export function InheritedDeleteButton() {
  const row = useInheritedRow();
  if (row.inherited && row.enforce) return null;
  return <DeleteButton />;
}
