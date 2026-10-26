import { Link } from "react-router-dom";
import { Code2, Globe2, ShieldCheck } from "lucide-react";
import EarlyAccessDialog from "@/components/EarlyAccessDialog";
import ContactDialog from "@/components/ContactDialog";
import { GITHUB_URL, docs } from "@/lib/links";
import { CLOUD, formatMau } from "@/lib/pricing";
import { cn } from "@/lib/utils";

const QUICKSTART_URL = docs("/getting-started");

// Button looks shared by the links and the dialog triggers on this page.
const solidButton =
  "inline-flex h-auto items-center justify-center rounded-xl bg-primary px-[26px] py-4 text-[17px] font-semibold text-primary-foreground hover:bg-primary/90";
const outlineButton =
  "inline-flex h-auto items-center justify-center rounded-xl border-[1.5px] border-input bg-transparent px-[25px] py-[15px] text-[17px] font-semibold text-foreground hover:bg-muted";

const sectionHeading =
  "text-[clamp(36px,4.4vw,56px)] font-bold leading-[1.02] tracking-[-0.04em]";

const pillars = [
  {
    icon: Code2,
    title: "Open source, all of it",
    body: "Every line that touches your users' credentials is on GitHub under AGPLv3. Read it, audit it, run it yourself. No lock-in, ever.",
  },
  {
    icon: Globe2,
    title: "Fast everywhere",
    body: "Logins run on Cloudflare's network, in the data centre closest to each user. No region to be slow from, and no servers to patch.",
  },
  {
    icon: ShieldCheck,
    title: "Made in Europe",
    body: "AuthHero is built by a European team. Self-host it on infrastructure you choose when data residency matters.",
  },
];

const features = [
  {
    title: "Social and enterprise logins",
    body: "Google, Apple, Microsoft, GitHub and any OIDC provider.",
  },
  {
    title: "Passwordless",
    body: "Email codes and magic links, alongside passwords.",
  },
  {
    title: "OAuth 2.0 and OpenID Connect",
    body: "Including silent auth, PKCE and dynamic client registration.",
  },
  {
    title: "Safe refresh tokens",
    body: "Rotation with reuse detection, so a stolen token stops working.",
  },
  { title: "Account linking", body: "One user, several ways to sign in." },
  { title: "Actions", body: "Run your own code during login and sign-up." },
  {
    title: "Multi-tenant",
    body: "Separate tenants per customer or environment.",
  },
  {
    title: "GDPR tooling",
    body: "Audit log and true erasure through crypto-shredding.",
  },
];

// The commands the "local" template prints as its next steps.
const terminalCommands = ["cd my-auth", "npm run migrate", "npm run dev"];

/** A static picture of the hosted login page; not a working form. */
const LoginIllustration = () => (
  <div
    aria-hidden="true"
    className="flex flex-col items-center gap-[26px] rounded-[28px] bg-brand px-5 pb-8 pt-14 sm:px-10"
  >
    <div className="flex w-full max-w-[380px] flex-col gap-[18px] rounded-[18px] bg-background px-8 pb-[26px] pt-9 shadow-[0_1px_2px_rgba(24,24,27,0.08),0_24px_48px_-16px_rgba(24,24,27,0.28)]">
      <div className="flex flex-col items-center gap-3 pb-1.5">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-xl font-bold text-primary-foreground">
          A
        </div>
        <span className="text-[22px] font-bold tracking-[-0.02em]">
          Sign in to Acme
        </span>
      </div>
      <div className="flex items-center justify-center gap-2.5 rounded-[10px] border border-input px-4 py-[13px] text-base font-medium">
        <svg width="18" height="18" viewBox="0 0 24 24">
          <path
            fill="#4285F4"
            d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.7Z"
          />
          <path
            fill="#34A853"
            d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.1-4 1.1-3.1 0-5.7-2.1-6.6-4.9h-4v3.1A12 12 0 0 0 12 24Z"
          />
          <path
            fill="#FBBC05"
            d="M5.4 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z"
          />
          <path
            fill="#EA4335"
            d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z"
          />
        </svg>
        Continue with Google
      </div>
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground/80">Email</span>
        <span className="rounded-[10px] border border-input px-3.5 py-3 text-base">
          maria@acme.eu
        </span>
      </div>
      <div className="rounded-[10px] bg-primary px-4 py-[13px] text-center text-base font-semibold text-primary-foreground">
        Send me a login code
      </div>
      <span className="pt-1 text-center text-[13px] text-muted-foreground">
        Secured by AuthHero
      </span>
    </div>
    <div className="flex items-center gap-2.5 rounded-full bg-background px-4 py-[9px] text-[15px] shadow-[0_1px_2px_rgba(24,24,27,0.08)]">
      <span className="h-2 w-2 rounded-full bg-success" />
      Served from the location closest to Maria
    </div>
  </div>
);

const Index = () => (
  <main className="text-lg leading-[1.55]">
    {/* Hero */}
    <section
      id="top"
      className="page flex flex-wrap items-center gap-[72px] pb-24 pt-10 md:pb-[120px] md:pt-14"
    >
      <div className="flex min-w-0 flex-[1_1_480px] flex-col gap-[30px]">
        <h1 className="text-[clamp(46px,6.4vw,84px)] font-bold leading-[0.98] tracking-[-0.045em]">
          Open-source auth that runs at the edge.
        </h1>
        <p className="max-w-[30em] text-[21px] leading-normal text-foreground/80">
          AuthHero is an OAuth and OpenID Connect server for your apps.
          Self-host it on Cloudflare in minutes, or let us run it for you.
        </p>
        <div className="flex flex-wrap gap-3">
          <EarlyAccessDialog className={solidButton}>
            Get early access
          </EarlyAccessDialog>
          <a href="#open-source" className={outlineButton}>
            Deploy it yourself
          </a>
        </div>
        <p className="text-base text-muted-foreground">
          Already on Auth0?{" "}
          <a
            href="#auth0"
            className="text-foreground underline underline-offset-2"
          >
            Your SDKs work with AuthHero.
          </a>
        </p>
      </div>
      <div className="min-w-0 flex-[1_1_460px]">
        <LoginIllustration />
      </div>
    </section>

    {/* Pillars */}
    <section id="product" className="bg-muted">
      <div className="page grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-14 py-24">
        {pillars.map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex flex-col gap-3.5">
            <Icon className="h-8 w-8" strokeWidth={1.7} aria-hidden="true" />
            <h2 className="text-[26px] font-bold tracking-[-0.025em]">
              {title}
            </h2>
            <p className="text-foreground/80">{body}</p>
          </div>
        ))}
      </div>
    </section>

    {/* Self-host */}
    <section
      id="open-source"
      className="page flex flex-wrap items-center gap-[72px] py-24 md:py-32"
    >
      <div className="flex min-w-0 flex-[1_1_420px] flex-col gap-[22px]">
        <h2 className={sectionHeading}>
          Your own auth server in about five minutes.
        </h2>
        <p className="max-w-[30em] text-[19px] text-foreground/80">
          One command scaffolds a Cloudflare Workers project with its database
          migrations. Run it locally, then deploy it to your own Cloudflare
          account. The free tier is enough to run real apps.
        </p>
        <div className="flex flex-wrap gap-3">
          <a
            href={QUICKSTART_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={solidButton}
          >
            Read the quickstart
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={outlineButton}
          >
            Star on GitHub
          </a>
        </div>
      </div>
      <div className="min-w-0 flex-[1_1_520px] overflow-hidden rounded-[20px] bg-primary">
        <div className="flex gap-2 px-5 py-4" aria-hidden="true">
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className="h-[11px] w-[11px] rounded-full bg-primary-foreground/20"
            />
          ))}
        </div>
        <pre className="overflow-x-auto px-7 pb-8 pt-2 font-mono text-[15px] leading-loose text-primary-foreground/90">
          {["npx create-authhero my-auth", ...terminalCommands].map(
            (command) => (
              <span key={command}>
                <span className="text-primary-foreground/60">$</span> {command}
                {"\n"}
              </span>
            ),
          )}
          {"\n"}
          <span className="rounded bg-brand px-2 py-0.5 font-bold text-brand-foreground">
            Ready
          </span>
          {"  "}https://localhost:3000
        </pre>
      </div>
    </section>

    {/* Auth0 compatibility */}
    <section id="auth0" className="bg-muted">
      <div className="page flex flex-wrap items-center gap-[72px] py-24 md:py-[120px]">
        <div className="order-2 flex min-w-0 flex-[1_1_520px] flex-col gap-[22px]">
          <h2 className={sectionHeading}>
            Already using Auth0? Keep your code.
          </h2>
          <p className="max-w-[30em] text-[19px] text-foreground/80">
            AuthHero implements the Auth0 Authentication and Management APIs, so
            auth0-spa-js, auth0-react and the rest work as they are. Import your
            users with their passwords, then point the SDK at your new domain.
          </p>
          <Link
            to="/migration"
            className="self-start text-[17px] font-semibold underline underline-offset-2"
          >
            Read the migration guide
          </Link>
        </div>
        <div className="order-1 min-w-0 flex-[1_1_460px] overflow-hidden rounded-[20px] border border-border bg-background">
          <div className="border-b border-border px-6 py-4 font-mono text-sm text-muted-foreground">
            src/auth.ts
          </div>
          <div className="overflow-x-auto whitespace-pre py-5 font-mono text-[15px] leading-[1.9]">
            <div className="px-6 text-muted-foreground">
              {"const auth = new Auth0Client({"}
            </div>
            <div className="bg-[#FDECEA] px-6 text-[#A3261A]">
              {'-  domain: "acme.eu.auth0.com",'}
            </div>
            <div className="bg-brand px-6 font-bold text-brand-foreground">
              {'+  domain: "auth.acme.eu",'}
            </div>
            <div className="px-6 text-muted-foreground">
              {'   clientId: "YOUR_CLIENT_ID",'}
            </div>
            <div className="px-6 text-muted-foreground">{"});"}</div>
          </div>
        </div>
      </div>
    </section>

    {/* Features */}
    <section
      id="features"
      className="page flex flex-wrap gap-[72px] py-24 md:py-32"
    >
      <div className="flex min-w-0 flex-[1_1_340px] flex-col gap-[18px]">
        <h2 className={sectionHeading}>Everything a login needs.</h2>
        <p className="text-[19px] text-foreground/80">
          Standards-based, so it fits whatever you already run.
        </p>
      </div>
      <div className="grid min-w-0 flex-[2_1_560px] grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-x-12">
        {features.map((feature) => (
          <div key={feature.title} className="border-t border-border py-5">
            <h3 className="mb-1 text-[19px] font-semibold tracking-normal">
              {feature.title}
            </h3>
            <p className="text-base text-muted-foreground">{feature.body}</p>
          </div>
        ))}
      </div>
    </section>

    {/* Pricing */}
    <section id="pricing" className="page flex flex-col gap-10 pb-24 md:pb-32">
      <h2 className={sectionHeading}>Run it yourself, or let us.</h2>
      <div className="flex flex-wrap gap-6">
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-5 rounded-[22px] border border-border p-8 sm:p-10">
          <h3 className="text-[26px] font-bold">Self-hosted</h3>
          <span className="text-[44px] font-bold leading-none tracking-[-0.04em]">
            Free
          </span>
          <p className="text-foreground/80">
            The full server, on your own Cloudflare account. Community support
            on GitHub.
          </p>
          <a
            href={QUICKSTART_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(outlineButton, "mt-auto self-start py-3.5")}
          >
            Deploy it yourself
          </a>
        </div>
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-5 rounded-[22px] bg-primary p-8 text-primary-foreground sm:p-10">
          <h3 className="text-[26px] font-bold text-primary-foreground">
            AuthHero Cloud
          </h3>
          <span className="text-[44px] font-bold leading-none tracking-[-0.04em]">
            Coming soon
          </span>
          <p className="text-primary-foreground/80">
            Fully managed on Cloudflare, with custom domains and no servers to
            run. Free up to {formatMau(CLOUD.free.mau)} monthly active users.
          </p>
          <div className="mt-auto flex flex-wrap items-center gap-5">
            <EarlyAccessDialog
              className={cn(
                solidButton,
                "bg-brand py-[15px] text-brand-foreground hover:bg-brand/90",
              )}
            >
              Get early access
            </EarlyAccessDialog>
            <Link
              to="/pricing"
              className="text-[17px] font-semibold text-primary-foreground underline underline-offset-2"
            >
              See all plans
            </Link>
          </div>
        </div>
      </div>
    </section>

    {/* Customers */}
    <section className="page pb-24 md:pb-[120px]">
      <div className="flex flex-wrap items-center justify-between gap-8 border-t border-border pt-12">
        <p className="max-w-[24em] text-[19px] text-foreground/80">
          Handling sign-in for millions of users at Linkfire and Sesamy.
        </p>
        <div className="flex flex-wrap items-center gap-10 sm:gap-14">
          <img
            src="/logos/linkfire.svg"
            alt="Linkfire"
            className="h-9 w-auto"
          />
          <img src="/logos/sesamy.svg" alt="Sesamy" className="h-7 w-auto" />
        </div>
      </div>
    </section>

    {/* CTA */}
    <section className="bg-brand text-brand-foreground">
      <div className="page flex flex-wrap items-end justify-between gap-10 py-24 md:py-28">
        <h2 className="min-w-0 flex-[1_1_560px] text-[clamp(42px,5.6vw,76px)] font-bold leading-[0.98] tracking-[-0.045em] text-brand-foreground">
          Add login to your app this afternoon.
        </h2>
        <div className="flex flex-wrap gap-3">
          <EarlyAccessDialog className={solidButton}>
            Get early access
          </EarlyAccessDialog>
          <ContactDialog
            topic="Landing page"
            variant="outline"
            className={cn(
              outlineButton,
              "border-brand-foreground hover:bg-brand-foreground/10 hover:text-brand-foreground",
            )}
          >
            Talk to us
          </ContactDialog>
        </div>
      </div>
    </section>
  </main>
);

export default Index;
