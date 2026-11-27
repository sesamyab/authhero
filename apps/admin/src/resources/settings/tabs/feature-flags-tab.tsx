import { BooleanInput } from "@/components/admin";

export function FeatureFlagsTab() {
  return (
    <div className="flex flex-col gap-3">
      <BooleanInput
        source="flags.universal_login_version"
        label="Use the widget login (/u2)"
        format={(value) => value === "2"}
        parse={(checked) => (checked ? "2" : "1")}
        helperText="AuthHero extension. When on, the tenant's applications use the widget login at /u2; when off, the classic login at /u, which is removed in 1.0. An application can override this under Applications → Details → Login version."
      />
      <BooleanInput
        source="allow_organization_name_in_authentication_api"
        label="Allow Organization Name in Authentication API"
        helperText="Allow using organization names (instead of IDs) in the /authorize endpoint and include org_name claim in tokens"
      />
      <BooleanInput
        source="flags.allow_legacy_delegation_grant_types"
        label="Allow Legacy Delegation Grant Types"
      />
      <BooleanInput
        source="flags.allow_legacy_ro_grant_types"
        label="Allow Legacy RO Grant Types"
      />
      <BooleanInput
        source="flags.allow_legacy_tokeninfo_endpoint"
        label="Allow Legacy Token Info Endpoint"
      />
      <BooleanInput
        source="flags.disable_clickjack_protection_headers"
        label="Disable Clickjack Protection Headers"
      />
      <BooleanInput
        source="flags.enable_apis_section"
        label="Enable APIs Section"
      />
      <BooleanInput
        source="flags.enable_client_connections"
        label="Enable Client Connections"
      />
      <BooleanInput
        source="flags.enable_custom_domain_in_emails"
        label="Enable Custom Domain in Emails"
      />
      <BooleanInput
        source="flags.enable_dynamic_client_registration"
        label="Enable Dynamic Client Registration"
      />
      <BooleanInput
        source="flags.dcr_require_initial_access_token"
        label="Require Initial Access Token for DCR"
        helperText="AuthHero extension (no Auth0 equivalent). When off, /oidc/register is open and any caller can register a client — matches Auth0's behavior. When on, callers must present a valid RFC 7591 Initial Access Token (minted via the management API or the consent flow). Turn this on for self-hosted deployments without rate-limiting in front of /oidc/register."
      />
      <BooleanInput
        source="flags.client_id_metadata_document_registration"
        label="Client ID Metadata Document Registration"
        helperText="Enables Client ID Metadata Documents (CIMD): clients pass an https URL as `client_id`; the authorization server fetches it at request time to discover their metadata, with no pre-registration. Advertised as `client_id_metadata_document_supported` in the OAuth AS metadata. Off by default."
      />
      <BooleanInput
        source="flags.enable_idtoken_api2"
        label="Enable ID Token API v2"
      />
      <BooleanInput
        source="flags.enable_legacy_logs_search_v2"
        label="Enable Legacy Logs Search v2"
      />
      <BooleanInput
        source="flags.enable_legacy_profile"
        label="Enable Legacy Profile"
      />
      <BooleanInput source="flags.enable_pipeline2" label="Enable Pipeline 2" />
      <BooleanInput
        source="flags.enable_public_signup_user_exists_error"
        label="Enable Public Signup User Exists Error"
      />
      <BooleanInput
        source="flags.use_scope_descriptions_for_consent"
        label="Use Scope Descriptions for Consent"
      />
      <BooleanInput
        source="flags.disable_management_api_sms_obfuscation"
        label="Disable Management API SMS Obfuscation"
      />
      <BooleanInput
        source="flags.enable_adfs_waad_email_verification"
        label="Enable ADFS WAAD Email Verification"
      />
      <BooleanInput
        source="flags.revoke_refresh_token_grant"
        label="Revoke Refresh Token Grant"
      />
      <BooleanInput
        source="flags.dashboard_log_streams_next"
        label="Dashboard Log Streams Next"
      />
      <BooleanInput
        source="flags.dashboard_insights_view"
        label="Dashboard Insights View"
      />
      <BooleanInput
        source="flags.disable_fields_map_fix"
        label="Disable Fields Map Fix"
      />
      <BooleanInput
        source="flags.mfa_show_factor_list_on_enrollment"
        label="MFA Show Factor List on Enrollment"
      />
      <BooleanInput
        source="flags.inherit_global_permissions_in_organizations"
        label="Inherit Tenant Permissions in Organizations"
        helperText="When enabled, tenant-level permissions will be inherited when users request organization-scoped tokens"
      />
    </div>
  );
}
