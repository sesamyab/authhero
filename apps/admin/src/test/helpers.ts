import type { AuthProvider } from "ra-core";

/**
 * Browser APIs the admin-kit components (Radix popovers, selects, sidebars)
 * call that jsdom does not have. Call from `beforeAll`; existing
 * implementations are left alone.
 */
export function installDomPolyfills(): void {
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
  window.matchMedia ??= (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

/**
 * A signed-in auth provider whose user holds `permissions`, as the admin
 * reads them from the token's `permissions` claim. `null` stands for a pasted
 * token or client credentials (everything allowed); "pending" never answers,
 * to see what a screen shows while the token is read.
 */
export function authProviderWith(
  permissions: string[] | null | "pending",
): AuthProvider {
  return {
    login: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    checkAuth: () => Promise.resolve(),
    checkError: () => Promise.resolve(),
    getPermissions: () => Promise.resolve(),
    getManagementPermissions: () =>
      permissions === "pending"
        ? new Promise<never>(() => {})
        : Promise.resolve(permissions),
  } as AuthProvider;
}
