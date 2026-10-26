import { Link } from "react-router-dom";
import LogoMark from "@/components/Logo";
import { GITHUB_URL, docs } from "@/lib/links";

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

const columns: { title: string; links: FooterLink[] }[] = [
  {
    title: "Product",
    links: [
      { label: "Pricing", href: "/pricing" },
      { label: "Coming from Auth0", href: "/migration" },
      { label: "Deployment options", href: "/deploy" },
    ],
  },
  {
    title: "Developers",
    links: [
      { label: "Docs", href: docs(), external: true },
      { label: "GitHub", href: GITHUB_URL, external: true },
      { label: "Changelog", href: docs("/changelog/"), external: true },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Blog", href: "/blog" },
      { label: "Security", href: docs("/security/"), external: true },
    ],
  },
];

const linkClass = "text-muted-foreground hover:text-foreground";

const Footer = () => (
  <footer>
    <div className="page flex flex-wrap justify-between gap-10 py-14 text-base">
      <div className="flex flex-[1_1_260px] flex-col gap-3">
        <span className="flex items-center gap-2.5">
          <LogoMark size={24} />
          <span className="text-lg font-bold tracking-[-0.03em]">AuthHero</span>
        </span>
        <span className="text-muted-foreground">
          Made in Europe by the team from Acast and Sesamy.
        </span>
      </div>
      <div className="flex flex-wrap gap-10 sm:gap-16">
        {columns.map((column) => (
          <div key={column.title} className="flex flex-col gap-2.5">
            <span className="font-semibold">{column.title}</span>
            {column.links.map((link) =>
              link.external ? (
                <a
                  key={link.label}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={linkClass}
                >
                  {link.label}
                </a>
              ) : (
                <Link key={link.label} to={link.href} className={linkClass}>
                  {link.label}
                </Link>
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  </footer>
);

export default Footer;
