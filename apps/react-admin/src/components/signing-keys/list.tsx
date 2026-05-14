import {
  List,
  Datagrid,
  TextField,
  FunctionField,
  TopToolbar,
  useDataProvider,
  useNotify,
  useRefresh,
  useListContext,
  useRecordContext,
} from "react-admin";
import { useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
} from "@mui/material";
import RotateRightIcon from "@mui/icons-material/RotateRight";
import BlockIcon from "@mui/icons-material/Block";
import { DateAgo } from "../common";
import type { AuthHeroDataProvider } from "../../auth0DataProvider";

interface SigningKeyRecord {
  id: string;
  kid: string;
  type: "jwt_signing" | "saml_encryption";
  tenant_id?: string;
  thumbprint?: string;
  fingerprint?: string;
  current?: boolean;
  current_since?: string;
  current_until?: string;
  revoked?: boolean;
  revoked_at?: string;
}

function ScopeBanner() {
  const { data, isLoading } = useListContext<SigningKeyRecord>();
  if (isLoading) return null;
  if (!data || data.length === 0) {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        No signing keys yet. Use <strong>Rotate</strong> to mint the first one.
      </Alert>
    );
  }
  // Control-plane keys have no tenant_id. If every key is unscoped we're in
  // the shared bucket; otherwise we're operating on tenant-scoped keys.
  const isControlPlane = data.every((key) => !key.tenant_id);
  return (
    <Alert severity={isControlPlane ? "warning" : "info"} sx={{ mb: 2 }}>
      {isControlPlane ? (
        <>
          Showing the <strong>shared control-plane</strong> bucket. Rotating
          here affects every tenant that falls back to it — switch the tenant to{" "}
          <code>signingKeyMode: "tenant"</code> first if you only want to rotate
          this tenant's keys.
        </>
      ) : (
        <>
          Showing this tenant's <strong>tenant-scoped</strong> signing keys.
        </>
      )}
    </Alert>
  );
}

function RotateButton() {
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const notify = useNotify();
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleRotate = async () => {
    setBusy(true);
    try {
      await dataProvider.rotateSigningKeys();
      notify("Signing keys rotated", { type: "success" });
      setOpen(false);
      refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to rotate keys";
      notify(message, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        startIcon={<RotateRightIcon />}
        onClick={() => setOpen(true)}
        variant="contained"
        color="primary"
      >
        Rotate
      </Button>
      <Dialog open={open} onClose={() => !busy && setOpen(false)}>
        <DialogTitle>Rotate signing keys</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This mints a fresh JWT signing key and schedules every existing key
            in this scope for revocation (with a one-day grace window so
            in-flight tokens can still be verified). Issued tokens stay valid
            until they expire.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={handleRotate}
            disabled={busy}
            variant="contained"
            color="primary"
          >
            {busy ? "Rotating…" : "Rotate"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function RevokeButton() {
  const record = useRecordContext<SigningKeyRecord>();
  const dataProvider = useDataProvider<AuthHeroDataProvider>();
  const notify = useNotify();
  const refresh = useRefresh();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!record || record.revoked_at) return null;

  const handleRevoke = async () => {
    setBusy(true);
    try {
      await dataProvider.revokeSigningKey(record.kid);
      notify("Signing key revoked", { type: "success" });
      setOpen(false);
      refresh();
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to revoke key";
      notify(message, { type: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="small"
        startIcon={<BlockIcon />}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        color="error"
      >
        Revoke
      </Button>
      <Dialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        onClick={(event) => event.stopPropagation()}
      >
        <DialogTitle>Revoke this key?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Tokens signed by <code>{record.kid}</code> will be rejected once
            verifiers refresh JWKS. Make sure another key is still active in
            this scope, or rotate first.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={handleRevoke}
            disabled={busy}
            variant="contained"
            color="error"
          >
            {busy ? "Revoking…" : "Revoke"}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function StatusChip() {
  const record = useRecordContext<SigningKeyRecord>();
  if (!record) return null;
  if (record.revoked_at) {
    return <Chip size="small" label="Revoked" color="default" />;
  }
  if (record.current) {
    return <Chip size="small" label="Current" color="success" />;
  }
  return <Chip size="small" label="Active" color="primary" />;
}

const SigningKeysActions = () => (
  <TopToolbar>
    <RotateButton />
  </TopToolbar>
);

const SigningKeysDatagrid = () => (
  <>
    <ScopeBanner />
    <Datagrid bulkActionButtons={false} rowClick={false}>
      <FunctionField label="Status" render={() => <StatusChip />} />
      <FunctionField<SigningKeyRecord>
        label="Kid"
        render={(record) => (
          <Box
            component="code"
            sx={{
              fontFamily: "monospace",
              fontSize: "0.85em",
              maxWidth: 220,
              display: "inline-block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              verticalAlign: "middle",
            }}
            title={record?.kid}
          >
            {record?.kid}
          </Box>
        )}
      />
      <TextField source="type" label="Type" />
      <FunctionField<SigningKeyRecord>
        label="Current since"
        render={(record) => <DateAgo date={record?.current_since} />}
      />
      <FunctionField<SigningKeyRecord>
        label="Revoked"
        render={(record) =>
          record?.revoked_at ? <DateAgo date={record.revoked_at} /> : "—"
        }
      />
      <FunctionField label="" render={() => <RevokeButton />} />
    </Datagrid>
  </>
);

export const SigningKeysList = () => (
  <List
    actions={<SigningKeysActions />}
    exporter={false}
    pagination={false}
    perPage={100}
    sort={{ field: "current_since", order: "DESC" }}
    title="Signing Keys"
  >
    <SigningKeysDatagrid />
  </List>
);
