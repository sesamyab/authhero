interface LogoProps {
  size?: number;
}

/** The saffron "plus" mark used in the header and footer. */
const LogoMark = ({ size = 28 }: LogoProps) => (
  <svg width={size} height={size} viewBox="0 0 28 28" aria-hidden="true">
    <rect width="28" height="28" rx="8" className="fill-brand" />
    <path
      d="M14 7.5v13M7.5 14h13"
      className="stroke-brand-foreground"
      strokeWidth="3"
      strokeLinecap="round"
    />
  </svg>
);

export default LogoMark;
