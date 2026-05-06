# Exercises every auth0_* resource type the Linkfire terraform in /auth0 uses
# that authhero supports, against a local authhero server.
#
# Deliberately omitted (no authhero endpoint yet):
#   - auth0_log_stream         (no /api/v2/log-streams)
#   - auth0_attack_protection  (no /api/v2/attack-protection)
# Deliberately omitted (provider hangs on Create — investigate separately):
#   - auth0_prompt_custom_text (provider stays in "Still creating..." against
#     authhero's PUT /api/v2/prompts/{prompt}/custom-text/{language})

terraform {
  required_providers {
    auth0 = {
      source  = "auth0/auth0"
      version = "~> 1.25.0"
    }
  }
  required_version = ">= 1.3"
}

variable "domain" {
  type = string
}

variable "client_id" {
  type = string
}

variable "client_secret" {
  type      = string
  sensitive = true
}

provider "auth0" {
  domain        = var.domain
  client_id     = var.client_id
  client_secret = var.client_secret
  debug         = true
}

resource "auth0_resource_server" "test_api" {
  name       = "Test API"
  identifier = "https://test-api.example.com"
}

resource "auth0_resource_server_scopes" "test_api" {
  resource_server_identifier = auth0_resource_server.test_api.identifier
  scopes {
    name        = "read:items"
    description = "Read items"
  }
  scopes {
    name        = "write:items"
    description = "Write items"
  }
}

resource "auth0_client" "regular_web" {
  name                = "TF Regular Web App"
  app_type            = "regular_web"
  callbacks           = ["https://example.com/callback"]
  allowed_logout_urls = ["https://example.com/logout"]
  web_origins         = ["https://example.com"]
  grant_types         = ["authorization_code", "refresh_token"]
}

resource "auth0_client" "machine" {
  name        = "TF Machine Client"
  app_type    = "non_interactive"
  grant_types = ["client_credentials"]
}

resource "auth0_client_grant" "machine_to_api" {
  client_id = auth0_client.machine.id
  audience  = auth0_resource_server.test_api.identifier
  scopes    = ["read:items", "write:items"]
}

resource "auth0_connection" "username_password" {
  name     = "tf-database"
  strategy = "auth0"

  options {
    requires_username      = false
    brute_force_protection = true
  }
}

resource "auth0_connection_clients" "username_password_clients" {
  connection_id   = auth0_connection.username_password.id
  enabled_clients = [auth0_client.regular_web.id]
}

resource "auth0_role" "editor" {
  name        = "tf-editor"
  description = "Can edit items"
}

resource "auth0_role_permissions" "editor" {
  role_id = auth0_role.editor.id
  permissions {
    name                       = "write:items"
    resource_server_identifier = auth0_resource_server.test_api.identifier
  }
}

resource "auth0_organization" "acme" {
  name         = "tf-acme"
  display_name = "Acme Corp"
}

resource "auth0_organization_connections" "acme" {
  organization_id = auth0_organization.acme.id
  enabled_connections {
    connection_id              = auth0_connection.username_password.id
    assign_membership_on_login = false
  }
}

resource "auth0_action" "post_login_noop" {
  name    = "tf-post-login-noop"
  runtime = "node22"
  code    = <<-EOT
    exports.onExecutePostLogin = async (event, api) => {};
  EOT
  supported_triggers {
    id      = "post-login"
    version = "v3"
  }
}

resource "auth0_trigger_actions" "post_login" {
  trigger = "post-login"
  actions {
    id           = auth0_action.post_login_noop.id
    display_name = "tf-post-login-noop"
  }
}

resource "auth0_branding" "company" {
  logo_url = "https://example.com/logo.png"
  colors {
    primary         = "#0059d6"
    page_background = "#ffffff"
  }
}

resource "auth0_email_provider" "smtp" {
  name                 = "smtp"
  enabled              = true
  default_from_address = "noreply@example.com"
  credentials {
    smtp_host = "smtp.example.com"
    smtp_port = 587
    smtp_user = "user"
    smtp_pass = "pass"
  }
}

resource "auth0_custom_domain" "primary" {
  domain = "auth.example.com"
  type   = "auth0_managed_certs"
}

resource "auth0_guardian" "factors" {
  policy = "all-applications"
  email  = true
}

resource "auth0_tenant" "settings" {
  friendly_name     = "TF Test Tenant"
  default_directory = auth0_connection.username_password.name
  support_email     = "support@example.com"
  flags {
    revoke_refresh_token_grant = false
  }
}
