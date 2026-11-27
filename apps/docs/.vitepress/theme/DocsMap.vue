<script setup lang="ts">
/**
 * The docs landing page's section map, built from the sidebar config.
 *
 * The sidebar is the single curated list of pages, so the overview reads it
 * instead of keeping a second hand-written copy that drifts. Only the blurb
 * per section lives here; a section without one still renders, just without
 * a description.
 */
import { computed } from "vue";
import { useData, withBase } from "vitepress";

type SidebarItem = {
  text?: string;
  link?: string;
  items?: SidebarItem[];
};

const BLURBS: Record<string, string> = {
  "Getting Started": "Run AuthHero locally and sign in for the first time.",
  Architecture:
    "How the pieces fit: the core package, adapters, universal login, sessions and the hooks pipeline.",
  Entities:
    "The data model: tenants, users, organizations, applications, connections and tokens.",
  Features:
    "Auth flows, MFA, actions and hooks, forms, invitations, SCIM, audit logging and more.",
  Standards:
    "The OAuth 2.0, OpenID Connect and SAML specs AuthHero implements, and how conformance is tested.",
  "Security Model":
    "Scopes and permissions, management API access, tenant isolation, encryption and signing keys.",
  Database: "Schema, migrations and wiring a database into your app.",
  Deployment:
    "Docker, Cloudflare Workers (and Workers for Platforms), AWS, custom domains and cron jobs.",
  "Customization & Extensibility":
    "Adapters, the UI widget, embedded login, SAML, multi-tenancy and the proxy package.",
  "Apps & Tools": "The create-authhero CLI and the admin dashboard.",
  "Auth0 Comparison":
    "Differences from Auth0 and guides for migrating users, hooks, SAML and Terraform.",
  "API Reference":
    "Endpoints, pagination, error codes and other conventions of the HTTP API.",
  Contributing: "Set up the monorepo, run the tests and cut a release.",
  Changelog: "What changed, week by week.",
};

/** Max links shown per card; the rest are one click away via the section. */
const MAX_LINKS = 6;

const { theme } = useData();

const sections = computed(() => {
  const sidebar: unknown = theme.value.sidebar;
  if (!Array.isArray(sidebar)) return [];
  return sidebar
    .filter((group: SidebarItem) => group.text && group.items?.length)
    .map((group: SidebarItem) => {
      // Sub-groups without their own page (Entities → Identity, Standards →
      // OAuth 2.0) contribute their pages instead of disappearing.
      const items = (group.items ?? [])
        .flatMap((item) => (item.link ? [item] : (item.items ?? [])))
        .filter((item) => item.text && item.link && item.link !== "/");
      const overview = items.find((item) => item.text === "Overview");
      const links = items.filter((item) => item !== overview);
      return {
        title: group.text ?? "",
        blurb: BLURBS[group.text ?? ""],
        href: withBase(overview?.link ?? links[0]?.link ?? "/"),
        links: links.slice(0, MAX_LINKS).map((item) => ({
          text: item.text ?? "",
          href: withBase(item.link ?? "/"),
        })),
        more: Math.max(0, links.length - MAX_LINKS),
      };
    });
});
</script>

<template>
  <div class="docs-map">
    <section v-for="section in sections" :key="section.title" class="docs-map-card">
      <h3>
        <a :href="section.href">{{ section.title }}</a>
      </h3>
      <p v-if="section.blurb" class="docs-map-blurb">{{ section.blurb }}</p>
      <ul>
        <li v-for="link in section.links" :key="link.href">
          <a :href="link.href">{{ link.text }}</a>
        </li>
        <li v-if="section.more > 0" class="docs-map-more">
          <a :href="section.href">+ {{ section.more }} more</a>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.docs-map {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.docs-map-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 18px 20px;
  background: var(--vp-c-bg-soft);
}

.docs-map-card h3 {
  margin: 0 0 6px;
  padding: 0;
  border: none;
  font-size: 17px;
}

.docs-map-blurb {
  margin: 0 0 10px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.docs-map-card ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

.docs-map-card li {
  margin: 2px 0;
  font-size: 14px;
}

.docs-map-more a {
  color: var(--vp-c-text-2);
}
</style>
