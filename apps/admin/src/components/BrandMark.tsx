/** The AuthHero mark: an ink plus on a saffron rounded square. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true" className={className}>
      <rect width="28" height="28" rx="8" className="fill-brand" />
      <path
        d="M14 7.5v13M7.5 14h13"
        className="stroke-brand-foreground"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
