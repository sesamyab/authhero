import { useEffect, useState } from "react";
import { useAuthProvider } from "ra-core";

type PermissionsAuthProvider = {
  getManagementPermissions?: () => Promise<string[] | null>;
};

export interface ManagementPermissions {
  /** True until the token has been read. `can` answers false meanwhile. */
  loading: boolean;
  /**
   * Whether the user holds a management permission. With a pasted token or
   * client credentials there is no user to ask, so everything is allowed and
   * the server decides.
   */
  can: (permission: string) => boolean;
}

/**
 * The signed-in user's management permissions, read from the `permissions`
 * claim of their access token. The claim is left out when the user has none,
 * so a missing claim means no permissions. It decides what the screens offer;
 * the server still enforces every call.
 */
export function useManagementPermissions(): ManagementPermissions {
  const authProvider = useAuthProvider() as
    | (ReturnType<typeof useAuthProvider> & PermissionsAuthProvider)
    | undefined;
  const [state, setState] = useState<{
    loading: boolean;
    permissions: Set<string> | "all";
  }>({ loading: true, permissions: new Set() });

  useEffect(() => {
    let cancelled = false;
    const read = authProvider?.getManagementPermissions;
    if (!read) {
      setState({ loading: false, permissions: "all" });
      return;
    }
    read()
      .then((permissions) => {
        if (cancelled) return;
        setState({
          loading: false,
          permissions: permissions === null ? "all" : new Set(permissions),
        });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, permissions: new Set() });
      });
    return () => {
      cancelled = true;
    };
  }, [authProvider]);

  return {
    loading: state.loading,
    can: (permission) =>
      state.permissions === "all" || state.permissions.has(permission),
  };
}
