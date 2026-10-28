import { useCreatePath } from "ra-core";
import { Navigate } from "react-router-dom";

/** Keep old bookmarks and resource redirects pointing at the unified view. */
export function HookList() {
  const createPath = useCreatePath();
  return (
    <Navigate
      to={createPath({ resource: "action-triggers", type: "list" })}
      replace
    />
  );
}
