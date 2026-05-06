# Terraform

AuthHero implements the Auth0 Management API, so the official
[`auth0/auth0` Terraform provider](https://registry.terraform.io/providers/auth0/auth0/latest)
works against AuthHero with no fork or wrapper. You configure the provider the
same way you would for Auth0 — just point `domain` at your AuthHero deployment.

## Provider configuration

```hcl
terraform {
  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.25.0"
    }
  }
}

provider "auth0" {
  # Just the host — the provider auto-prefixes https:// and appends /api/v2/.
  domain        = "auth.example.com"
  client_id     = var.auth0_client_id
  client_secret = var.auth0_client_secret
}
```

### `domain` semantics

The `domain` field works exactly like it does for Auth0: pass the host of your
deployment, **without scheme and without path**. The provider's underlying
`go-auth0` SDK builds:

- token URL: `https://<domain>/oauth/token`
- API base: `https://<domain>/api/v2/`

::: warning HTTPS is required
`go-auth0` rewrites the scheme to `https://` regardless of what you pass
in `domain` (e.g. `http://...`). AuthHero must therefore be reachable over
TLS — either with a real certificate or, for local development, a
locally-trusted one (see [Local development](#local-development) below).
:::

## What you need to seed before running Terraform

The provider authenticates via the OAuth2 **client credentials grant**, which
means the deployment must have, ahead of time:

1. **A confidential client** with `grant_types` containing `client_credentials`
   and a known `client_secret` — these become the provider's `client_id` /
   `client_secret`.
2. **A Management API resource server** whose `identifier` matches what the
   provider requests as the audience: `https://<domain>/api/v2/`.
3. **A client grant** linking the client to the resource server with the
   scopes Terraform will exercise (typically all `read:*`, `create:*`,
   `update:*`, `delete:*` scopes for the resources you manage).

In an AuthHero deployment that has run the management-API seed (`seed()` from
`authhero`), the resource server, an admin role, and the scope set are already
in place — you only need to add the client + grant for the Terraform service
account.

A minimal seed snippet (run once during deployment):

```ts
import { seed } from "authhero";

await seed(adapters, { tenantId: "your-tenant" });

await adapters.clients.create("your-tenant", {
  client_id: "tf-provider",
  client_secret: process.env.TF_PROVIDER_SECRET,
  name: "Terraform Provider",
  grant_types: ["client_credentials"],
});

await adapters.clientGrants.create("your-tenant", {
  client_id: "tf-provider",
  audience: "https://auth.example.com/api/v2/",
  scope: ["read:clients", "create:clients", "update:clients", /* ... */],
});
```

## Supported resources

AuthHero supports the resources used in typical Auth0 deployments. The
[smoke-test fixture in the AuthHero repo](https://github.com/markusahlstrand/authhero/blob/main/packages/authhero/test/terraform/fixture/main.tf)
exercises one of each on every CI run, so the list below tracks what
genuinely works rather than what is documented to work:

| Resource                          | Status |
| --------------------------------- | ------ |
| `auth0_action`                    | ✓      |
| `auth0_branding`                  | ✓      |
| `auth0_client`                    | ✓      |
| `auth0_client_grant`              | ✓      |
| `auth0_connection`                | ✓      |
| `auth0_connection_clients`        | ✓      |
| `auth0_custom_domain`             | ✓      |
| `auth0_email_provider`            | ✓      |
| `auth0_guardian`                  | ✓      |
| `auth0_organization`              | ✓      |
| `auth0_organization_connections`  | ✓      |
| `auth0_resource_server`           | ✓      |
| `auth0_resource_server_scopes`    | ✓      |
| `auth0_role`                      | ✓      |
| `auth0_role_permissions`          | ✓      |
| `auth0_tenant`                    | ✓      |
| `auth0_trigger_actions`           | ✓      |

### Known gaps

These resources are intentionally absent from AuthHero today and will fail with
404 against the Management API:

- `auth0_log_stream` — no `/api/v2/log-streams` endpoint
- `auth0_attack_protection` — no `/api/v2/attack-protection` endpoint
- `auth0_prompt_custom_text` — endpoint exists but the provider's create flow
  has compat issues; investigate before relying on it

If you need any of these, open an issue on GitHub or contribute the missing
endpoint.

## Local development

If you want to run `terraform apply` against a local AuthHero instance, the
provider's HTTPS requirement means a plain `http://localhost:3000` won't work.
Use [mkcert](https://github.com/FiloSottile/mkcert) to install a locally-trusted
CA, then serve AuthHero over TLS with a cert signed by it:

```bash
brew install mkcert
mkcert -install                         # one-time, adds CA to system keychain
mkcert -cert-file cert.pem -key-file key.pem 127.0.0.1 localhost
```

Then start AuthHero with the cert (e.g. wrap `@hono/node-server`'s `serve()`
with `createServer` from `node:https` and pass `{ key, cert }`). The
provider's `domain` becomes `127.0.0.1:<port>` (or `localhost:<port>`); no
extra trust configuration is needed because the cert chains to a root that's
already in the system trust store.

::: tip macOS + Go
Go on macOS reads roots from the keychain (via the Security framework) and
ignores `SSL_CERT_FILE`. `mkcert -install` is therefore the correct path —
exporting an env var won't make a hand-rolled self-signed cert trusted.
:::

## CI

The AuthHero repo runs the smoke fixture as a Vitest test
(`packages/authhero/test/terraform/terraform.spec.ts`). It boots AuthHero
in-process over HTTPS, seeds the resource server + client + grant, then
spawns `terraform init` and `terraform apply`. The test self-skips when
`terraform` or `mkcert` aren't on `PATH`, so it can also run unattended on
CI runners where you've installed both binaries.

Use the same pattern in your own CI to gate releases on Terraform-provider
compatibility.
