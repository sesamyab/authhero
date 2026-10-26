// AuthHero Cloud plan limits shown on the site. Prices aren't published until
// Cloud launches, so only MAU and SSO allowances live here.

export const CLOUD = {
  free: {
    /** Monthly active users included on the free tier. */
    mau: 10_000,
    ssoConnections: 1,
  },
  pro: {
    /** MAU included before per-MAU pricing applies. */
    includedMau: 50_000,
    ssoConnections: 3,
  },
} as const;

/** "10,000" → "10k", "50,000" → "50k", "1,500,000" → "1.5M". */
export const formatMau = (mau: number): string => {
  if (mau >= 1_000_000) return `${(mau / 1_000_000).toLocaleString("en-US")}M`;
  if (mau >= 1_000) return `${(mau / 1_000).toLocaleString("en-US")}k`;
  return mau.toLocaleString("en-US");
};
