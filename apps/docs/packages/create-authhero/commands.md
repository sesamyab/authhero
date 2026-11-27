---
title: Create AuthHero CLI Commands
description: Reference for every create-authhero option — template, package manager, multi-tenant, admin UI, skip flags, GitHub CI, conformance and workspace mode.
---

# Create AuthHero CLI Commands

## Base command

```bash
npx create-authhero [project-name] [options]
```

## Options

| Option | Description |
| --- | --- |
| `-t, --template <type>` | `local`, `cloudflare`, `cloudflare-wfp-dispatcher`, `cloudflare-wfp-tenant`, `cloudflare-control-plane`, `aws-sst` or `proxy`. See [Templates](/packages/create-authhero/#templates). |
| `--package-manager <pm>` | `npm`, `yarn`, `pnpm` or `bun`. Default: `pnpm`. |
| `--multi-tenant` | Enable multi-tenant mode (`local`, `cloudflare`, `aws-sst`). |
| `--admin-ui` | Serve the admin dashboard at `/admin` (`local` and `cloudflare`). |
| `--skip-install` | Don't install dependencies. |
| `--skip-migrate` | Don't run the database migrations. |
| `--skip-start` | Don't start the development server. |
| `--github-ci` | Add GitHub CI workflows with semantic versioning (`cloudflare`). |
| `--conformance` | Add test clients for the OpenID Foundation conformance suite. |
| `--conformance-alias <alias>` | Alias for the conformance suite. Default: `authhero-local`. |
| `--workspace` | Use `workspace:*` dependencies, for developing inside the AuthHero monorepo. |
| `-y, --yes` | Skip the prompts and use the defaults or the options given. |
| `-V, --version` | Print the CLI version. |
| `-h, --help` | Show help. |

With `--yes`, the project name defaults to `auth-server`, multi-tenant mode is off and the admin UI is on. Pass `--template` as well — without it the CLI still asks for the setup type.

## Examples

Scaffold a local SQLite server without prompts, installing with npm (without `--package-manager`, `--yes` uses pnpm):

```bash
npx create-authhero my-app --template local --package-manager npm --yes
```

Scaffold a multi-tenant Cloudflare Worker with the admin UI, without installing:

```bash
npx create-authhero my-worker --template cloudflare --multi-tenant --admin-ui --skip-install --yes
```

Scaffold the Workers for Platforms control plane with npm:

```bash
npx create-authhero control-plane --template cloudflare-control-plane --package-manager npm --yes
```
