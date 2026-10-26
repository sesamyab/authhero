import { Link } from "react-router-dom";
import { Github, Menu, X } from "lucide-react";
import { useState } from "react";
import LogoMark from "@/components/Logo";
import EarlyAccessDialog from "@/components/EarlyAccessDialog";
import { DOCS_URL, GITHUB_URL } from "@/lib/links";

interface NavItem {
  label: string;
  href: string;
  external?: boolean;
}

const navItems: NavItem[] = [
  { label: "Product", href: "/#product" },
  { label: "Open source", href: "/#open-source" },
  { label: "Pricing", href: "/pricing" },
  { label: "Blog", href: "/blog" },
  { label: "Docs", href: DOCS_URL, external: true },
];

const NavItemLink = ({
  item,
  className,
  onClick,
}: {
  item: NavItem;
  className: string;
  onClick?: () => void;
}) =>
  // Hash links stay plain anchors so the browser scrolls to the section;
  // react-router's <Link> doesn't.
  item.external || item.href.includes("#") ? (
    <a
      href={item.href}
      {...(item.external && { target: "_blank", rel: "noopener noreferrer" })}
      className={className}
      onClick={onClick}
    >
      {item.label}
    </a>
  ) : (
    <Link to={item.href} className={className} onClick={onClick}>
      {item.label}
    </Link>
  );

const Navbar = () => {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 w-full bg-background/90 backdrop-blur-sm">
      <div className="page flex items-center justify-between gap-4 py-4 md:py-[22px]">
        <Link to="/" className="flex items-center gap-2.5">
          <LogoMark />
          <span className="text-[21px] font-bold tracking-[-0.03em]">
            AuthHero
          </span>
        </Link>

        {/* Desktop */}
        <nav
          aria-label="Main"
          className="hidden items-center gap-[30px] md:flex"
        >
          {navItems.map((item) => (
            <NavItemLink
              key={item.href}
              item={item}
              className="text-base hover:text-muted-foreground"
            />
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-3.5 py-2.5 text-base hover:text-muted-foreground"
          >
            <Github className="h-[18px] w-[18px]" strokeWidth={1.75} />
            GitHub
          </a>
          <EarlyAccessDialog
            size="default"
            className="h-auto rounded-[10px] px-[18px] py-[11px] text-base font-semibold"
          >
            Start free
          </EarlyAccessDialog>
        </div>

        {/* Mobile toggle */}
        <button
          className="flex h-11 w-11 items-center justify-center md:hidden"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
          aria-expanded={mobileOpen}
        >
          {mobileOpen ? (
            <X className="h-5 w-5" strokeWidth={1.75} />
          ) : (
            <Menu className="h-5 w-5" strokeWidth={1.75} />
          )}
        </button>
      </div>

      {/* Mobile menu */}
      {mobileOpen && (
        <div className="page space-y-1 border-t border-border bg-background pb-5 pt-3 md:hidden">
          {navItems.map((item) => (
            <NavItemLink
              key={item.href}
              item={item}
              onClick={() => setMobileOpen(false)}
              className="block py-2 text-base"
            />
          ))}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setMobileOpen(false)}
            className="block py-2 text-base"
          >
            GitHub
          </a>
          <div className="pt-2">
            <EarlyAccessDialog
              size="default"
              className="h-auto w-full rounded-[10px] py-3 text-base font-semibold"
            >
              Start free
            </EarlyAccessDialog>
          </div>
        </div>
      )}
    </header>
  );
};

export default Navbar;
