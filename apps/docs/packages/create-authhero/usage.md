---
title: Create AuthHero CLI Usage
description: Run create-authhero interactively — the questions it asks, what it installs and runs, and what to do next.
---

# Create AuthHero CLI Usage

## Prerequisites

- Node.js 20 or later
- npm, yarn, pnpm or bun

## Creating a project

```bash
npm create authhero@latest my-auth-app
```

If you leave out the project name, the CLI asks for one (default `auth-server`). The target directory must not exist yet.

## What the CLI asks

1. **Setup type** — one of the seven [templates](/packages/create-authhero/#templates).
2. **Multi-tenant mode** — asked for `local`, `cloudflare` and `aws-sst`. The control-plane template is always multi-tenant; the proxy, dispatcher and tenant-worker templates are single-tenant.
3. **Admin UI at `/admin`** — asked for `local` and `cloudflare` only.
4. **GitHub CI with semantic versioning** — asked for `cloudflare` only.
5. **Install dependencies now?** — and, if yes, which package manager (default `pnpm`).
6. **Run database migrations?** and **Start the development server?** — after a successful install.

The CLI does not ask which database adapter to use: each template comes with its own (Drizzle on SQLite or D1, or DynamoDB for `aws-sst`).

## After the project is created

If you let the CLI install, migrate and start, the server is already running. Otherwise:

```bash
cd my-auth-app
npm install
npm run migrate   # templates with a database
npm run dev
```

For the `local` template, open `https://localhost:3000/setup` on first run. The setup wizard creates the first tenant, the admin user and a `default` application — see [Your first login](/first-login).

Each template's `README.md` covers deployment for that target.
