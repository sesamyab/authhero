import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Head } from "vite-react-ssg";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import Navbar from "@/components/Navbar";
import Footer from "@/components/Footer";

const queryClient = new QueryClient();

// Client-side navigation keeps the old scroll position, so start each new page
// at the top. Hash links are left to the browser.
const ScrollToTop = () => {
  const { pathname, hash } = useLocation();
  useEffect(() => {
    if (!hash) window.scrollTo(0, 0);
  }, [pathname, hash]);
  return null;
};

const SITE_TITLE = "AuthHero — Open-source auth that runs at the edge";
const SITE_DESCRIPTION =
  "AuthHero is an open-source OAuth and OpenID Connect server. Self-host it on Cloudflare in minutes, or let us run it for you. Auth0 SDKs work as they are.";

const Layout = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      {/* Site-wide SEO defaults. Pages override title/description via their own
          <Head>; react-helmet-async dedupes by tag, so the innermost wins. */}
      <Head>
        <title>{SITE_TITLE}</title>
        <meta name="description" content={SITE_DESCRIPTION} />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={SITE_TITLE} />
        <meta property="og:description" content={SITE_DESCRIPTION} />
        <meta property="og:image" content="/og-image.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@authhero" />
        <meta name="twitter:title" content={SITE_TITLE} />
        <meta name="twitter:description" content={SITE_DESCRIPTION} />
        <meta name="twitter:image" content="/og-image.png" />
      </Head>
      <Toaster />
      <Sonner />
      <ScrollToTop />
      <Navbar />
      <Outlet />
      <Footer />
    </TooltipProvider>
  </QueryClientProvider>
);

export default Layout;
