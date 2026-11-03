import { detectAndCacheIncognito, isIncognito } from "../utils/incognito";

/**
 * IncognitoDetectionHandler - Detects incognito mode and shows the warning
 * This runs on the client-side after page load
 */
export const IncognitoDetectionHandler = () => {
  // Check if we already have the result cached
  const cached = isIncognito();

  if (cached !== undefined) {
    reportPrivateBrowsing(cached);
    // We have a cached result, show warning if needed
    if (cached) {
      showIncognitoWarning();
    }
    return;
  }

  // Otherwise, perform detection
  detectAndCacheIncognito()
    .then((isIncognitoMode) => {
      reportPrivateBrowsing(isIncognitoMode);
      if (isIncognitoMode) {
        showIncognitoWarning();
      }
    })
    .catch(() => {
      // If detection fails, don't show warning
    });
};

/**
 * Hand the result to the server, which can't detect private browsing itself.
 * A session cookie on the login host, read back into the login log
 * (getPrivateBrowsingCookie in utils/cookies.ts — keep the name in sync).
 */
function reportPrivateBrowsing(isPrivate: boolean) {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `authhero-private-browsing=${isPrivate ? "1" : "0"}; Path=/; SameSite=Lax${secure}`;
  } catch {
    // Cookies may be blocked; the log just won't carry the flag
  }
}

function showIncognitoWarning() {
  const container = document.getElementById("incognito-warning-container");
  if (!container) return;

  // Remove the hidden class to show the warning
  container.classList.remove("hidden");
}
