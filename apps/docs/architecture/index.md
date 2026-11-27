---
title: Architecture Overview
description: AuthHero's philosophy, architecture layers, and how the system is designed to run anywhere from a single process to a distributed deployment.
---

# Architecture Overview

## Philosophy

AuthHero is designed around a simple idea: **authentication should be easy to run, both locally and at scale**.

- **Run it anywhere** — AuthHero works as a library inside your existing Node.js process, as a standalone Docker container, or as a distributed deployment on Cloudflare Workers or AWS Lambda.
- **Start simple, scale later** — Begin with SQLite in development, then run on Cloudflare D1 at the edge, DynamoDB on AWS, or SQLite in a container. The adapter pattern means you never rewrite your auth logic.
- **Auth0-compatible** — Use existing Auth0 SDKs and tools. If you know Auth0, you already know AuthHero.
- **Open and extensible** — Every layer is pluggable: database adapters, authentication strategies, hooks, signing strategies, and UI components.

## Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│                    Your Application                      │
│            (or Admin UI / Auth0 Proxy / Demo)            │
└─────────────────────────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────┐
│                   AuthHero Package                       │
│  ┌─────────────┬──────────────────┬───────────────────┐ │
│  │ Auth API    │ Management API   │ Universal Login    │ │
│  │ OAuth2/OIDC │ /api/v2/*        │ /u2/* (widget)     │ │
│  └─────────────┴──────────────────┴───────────────────┘ │
└─────────────────────────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────┐
│              Adapter Layer (pluggable)                  │
│  Drizzle │ Kysely │ AWS │ Cloudflare │ Custom           │
└─────────────────────────────────────────────────────────┘
                           │
┌─────────────────────────────────────────────────────────┐
│                   Database / Storage                    │
│  SQLite │ D1 │ MySQL (PlanetScale) │ DynamoDB           │
└─────────────────────────────────────────────────────────┘
```

The core `authhero` package depends only on adapter interfaces — concrete database and platform adapters are injected at runtime.

## What's in Each Section

- [The AuthHero Package](/architecture/authhero-package) — The three parts: Auth API, Management API, and Universal Login
- [Auth0 Compatibility](/architecture/auth0-compatibility) — What's compatible and the key differences
- [Universal Login](/architecture/universal-login) — The u2 widget-based login and the legacy server-rendered login
- [Adapters](/architecture/adapters) — How the adapter pattern works, layering adapters for migration and fallback
- [Multi-Tenancy](/architecture/multi-tenancy) — Tenant isolation, organizations, and the multi-tenancy package
