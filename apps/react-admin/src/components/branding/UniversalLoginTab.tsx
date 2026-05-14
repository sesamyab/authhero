import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Typography,
  TextField,
  Button,
  Alert,
  CircularProgress,
  Paper,
  Divider,
  Link,
} from "@mui/material";
import { useNotify } from "react-admin";
import {
  authorizedHttpClient,
  createOrganizationHttpClient,
  isSingleTenantForDomain,
} from "../../authProvider";
import {
  getDomainFromStorage,
  buildUrlWithProtocol,
  formatDomain,
  getSelectedDomainFromStorage,
} from "../../utils/domainUtils";
import { getConfigValue, getBasePath } from "../../utils/runtimeConfig";

// Get tenantId from the URL path (e.g., /breakit/branding -> breakit)
function getTenantIdFromPath(): string {
  const basePath = getBasePath();
  const pathname = window.location.pathname;
  const relativePath =
    basePath && pathname.startsWith(basePath)
      ? pathname.slice(basePath.length)
      : pathname;
  const pathSegments = relativePath.split("/").filter(Boolean);
  return pathSegments[0] || "";
}

// Default body template — only the slot tokens. The page shell (html/head,
// CSS, dark-mode runtime, background tint) is fixed by AuthHero. Customize
// the body by removing slots to hide chips, or reordering them.
const DEFAULT_TEMPLATE = `{%- auth0:widget -%}
{%- authhero:logo -%}
{%- authhero:settings -%}
{%- authhero:powered-by -%}
{%- authhero:legal -%}
`;

function getApiUrl(): string {
  const domains = getDomainFromStorage();
  const selectedDomain = getSelectedDomainFromStorage();
  const formattedSelectedDomain = formatDomain(selectedDomain);
  const domainConfig = domains.find(
    (d) => formatDomain(d.url) === formattedSelectedDomain,
  );

  let apiUrl: string;

  if (domainConfig?.restApiUrl) {
    apiUrl = buildUrlWithProtocol(domainConfig.restApiUrl);
  } else if (selectedDomain) {
    apiUrl = buildUrlWithProtocol(selectedDomain);
  } else {
    apiUrl = buildUrlWithProtocol(getConfigValue("apiUrl"));
  }

  return apiUrl.replace(/\/$/, "");
}

function getHttpClient(tenantId: string) {
  const formattedDomain = formatDomain(getSelectedDomainFromStorage());
  // In single-tenant mode, use the regular authorized client without organization scope
  // In multi-tenant mode, use organization-scoped client for proper access control
  if (isSingleTenantForDomain(formattedDomain)) {
    return authorizedHttpClient;
  } else {
    return createOrganizationHttpClient(tenantId);
  }
}

export function UniversalLoginTab() {
  const notify = useNotify();
  const tenantId = getTenantIdFromPath();

  const [template, setTemplate] = useState<string>("");
  const [originalTemplate, setOriginalTemplate] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasTemplate, setHasTemplate] = useState(false);

  const fetchTemplate = useCallback(async () => {
    if (!tenantId) return;

    setLoading(true);
    setError(null);

    try {
      const apiUrl = getApiUrl();
      const httpClient = getHttpClient(tenantId);
      const url = `${apiUrl}/api/v2/branding/templates/universal-login`;

      const response = await httpClient(url, {
        headers: new Headers({
          "tenant-id": tenantId,
        }),
      });

      if (response.json?.body) {
        // The GET endpoint returns the AuthHero default body when no custom
        // template is stored, so a body alone doesn't prove the tenant has
        // saved one. Compare against the known default to distinguish
        // "default served by API" from "stored custom template" — this
        // controls whether the "Delete Template" action is shown and what
        // `hasChanges` is measured against.
        const body = response.json.body;
        const isCustom = body !== DEFAULT_TEMPLATE;
        setTemplate(body);
        setOriginalTemplate(body);
        setHasTemplate(isCustom);
      }
    } catch (err: any) {
      if (err.status === 404) {
        // No template exists yet, that's fine
        setTemplate("");
        setOriginalTemplate("");
        setHasTemplate(false);
      } else {
        setError("Failed to load template");
        console.error("Error fetching template:", err);
      }
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    fetchTemplate();
  }, [fetchTemplate]);

  const handleSave = async () => {
    if (!tenantId) return;

    // Body must mount the widget; chip slots are optional.
    if (!template.includes("{%- auth0:widget -%}")) {
      notify("Template must contain {%- auth0:widget -%} tag", {
        type: "error",
      });
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const apiUrl = getApiUrl();
      const httpClient = getHttpClient(tenantId);
      await httpClient(`${apiUrl}/api/v2/branding/templates/universal-login`, {
        method: "PUT",
        headers: new Headers({
          "tenant-id": tenantId,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ body: template }),
      });

      setOriginalTemplate(template);
      setHasTemplate(true);
      notify("Template saved successfully", { type: "success" });
    } catch (err: any) {
      setError(err.message || "Failed to save template");
      notify("Failed to save template", { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!tenantId) return;

    if (
      !window.confirm(
        "Are you sure you want to delete the custom template? The default template will be used instead.",
      )
    ) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const apiUrl = getApiUrl();
      const httpClient = getHttpClient(tenantId);
      await httpClient(`${apiUrl}/api/v2/branding/templates/universal-login`, {
        method: "DELETE",
        headers: new Headers({
          "tenant-id": tenantId,
        }),
      });

      setTemplate("");
      setOriginalTemplate("");
      setHasTemplate(false);
      notify("Template deleted successfully", { type: "success" });
    } catch (err: any) {
      setError(err.message || "Failed to delete template");
      notify("Failed to delete template", { type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const handleUseDefault = () => {
    setTemplate(DEFAULT_TEMPLATE);
  };

  const hasChanges = template !== originalTemplate;

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 1000, p: 2 }}>
      <Typography variant="h6" sx={{ mb: 2 }}>
        Universal Login Page Template
      </Typography>

      <Typography variant="body2" sx={{ mb: 3, color: "text.secondary" }}>
        Customize the Universal Login body. The page shell (CSS, dark-mode
        runtime, layout) is fixed by AuthHero — your template only controls
        which corner chips render. Delete a slot to hide that pill.
      </Typography>

      <Alert severity="info" sx={{ mb: 3 }}>
        <Typography variant="body2">
          <strong>Slots:</strong>
          <ul style={{ margin: "8px 0", paddingLeft: "20px" }}>
            <li>
              <code>{"{%- auth0:widget -%}"}</code> — login widget mount
              (required)
            </li>
            <li>
              <code>{"{%- authhero:logo -%}"}</code> — top-left logo chip
            </li>
            <li>
              <code>{"{%- authhero:settings -%}"}</code> — top-right settings
              chip (dark-mode toggle + language picker)
            </li>
            <li>
              <code>{"{%- authhero:dark-mode-toggle -%}"}</code> — dark-mode
              button only
            </li>
            <li>
              <code>{"{%- authhero:language-picker -%}"}</code> — language
              picker only
            </li>
            <li>
              <code>{"{%- authhero:powered-by -%}"}</code> — bottom-left
              powered-by chip
            </li>
            <li>
              <code>{"{%- authhero:legal -%}"}</code> — bottom-right legal chip
            </li>
          </ul>
          <Link
            href="https://auth0.com/docs/authenticate/login/auth0-universal-login/new-experience/universal-login-page-templates"
            target="_blank"
            rel="noopener noreferrer"
          >
            Learn more about page templates
          </Link>
        </Typography>
      </Alert>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Paper variant="outlined" sx={{ mb: 2 }}>
        <TextField
          multiline
          fullWidth
          minRows={15}
          maxRows={30}
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          placeholder="Enter your custom HTML template..."
          sx={{
            "& .MuiInputBase-root": {
              fontFamily: "monospace",
              fontSize: "13px",
            },
            "& .MuiOutlinedInput-notchedOutline": {
              border: "none",
            },
          }}
        />
      </Paper>

      <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving || !template || !hasChanges}
        >
          {saving ? <CircularProgress size={20} /> : "Save Template"}
        </Button>

        {!template && (
          <Button variant="outlined" onClick={handleUseDefault}>
            Use Default Template
          </Button>
        )}

        {hasTemplate && (
          <Button
            variant="outlined"
            color="error"
            onClick={handleDelete}
            disabled={saving}
          >
            Delete Template
          </Button>
        )}

        {hasChanges && (
          <Button
            variant="text"
            onClick={() => setTemplate(originalTemplate)}
            disabled={saving}
          >
            Discard Changes
          </Button>
        )}
      </Box>

      {hasChanges && (
        <Typography
          variant="caption"
          sx={{ display: "block", mt: 1, color: "warning.main" }}
        >
          You have unsaved changes
        </Typography>
      )}

      <Divider sx={{ my: 4 }} />

      <Typography variant="subtitle2" sx={{ mb: 1, color: "text.secondary" }}>
        Template Variables
      </Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        You can use Liquid variables to customize your template:
        <ul style={{ margin: "8px 0", paddingLeft: "20px" }}>
          <li>
            <code>{"{{ branding.logo_url }}"}</code> - Your logo URL
          </li>
          <li>
            <code>{"{{ branding.colors.primary }}"}</code> - Primary color
          </li>
          <li>
            <code>{"{{ prompt.screen.name }}"}</code> - Current screen name
          </li>
        </ul>
      </Typography>
    </Box>
  );
}
