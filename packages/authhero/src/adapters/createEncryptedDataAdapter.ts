import {
  Action,
  ActionVersion,
  ActionVersionsAdapter,
  ActionsAdapter,
  AuthenticationMethodsAdapter,
  ClientConnectionsAdapter,
  ClientsAdapter,
  Connection,
  ConnectionsAdapter,
  DataAdapters,
  EmailProvidersAdapter,
  HookCodeAdapter,
  MigrationSourcesAdapter,
} from "@authhero/adapter-interfaces";
import {
  decryptFieldWithRing,
  encryptFieldWithRing,
  isEncrypted,
  KeyRing,
} from "../utils/field-encryption";

// A bidirectional codec bound to a single tenant. `encrypt` already knows which
// key id to tag values with (resolved from the tenant id), and skips values
// that are already encrypted so writes stay idempotent. `decrypt` selects the
// key from the id embedded in the ciphertext, so it is tenant-agnostic.
interface FieldCodec {
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
}

type Transform = (value: string) => Promise<string>;

/**
 * Resolves which key id (if any) a tenant's secrets are encrypted under.
 * Returning `undefined` uses the ring's default key and produces legacy,
 * untagged `enc:v1:` ciphertext — byte-compatible with the single-key adapter.
 *
 * The canonical use: tag rows owned by the control plane tenant with a
 * control-plane-only key id, so the same database can hold a tenant's own
 * secrets (default key) alongside inherited control plane secrets the tenant
 * operator cannot decrypt.
 */
export type EncryptKeyIdResolver = (tenantId: string) => string | undefined;

interface EncryptionOptions {
  resolveEncryptKeyId?: EncryptKeyIdResolver;
}

function makeCodecFactory(
  ring: KeyRing,
  resolveEncryptKeyId?: EncryptKeyIdResolver,
): (tenantId: string) => FieldCodec {
  return (tenantId: string): FieldCodec => {
    const keyId = resolveEncryptKeyId?.(tenantId);
    return {
      encrypt: (value) =>
        isEncrypted(value)
          ? Promise.resolve(value)
          : encryptFieldWithRing(value, ring, keyId),
      decrypt: (value) => decryptFieldWithRing(value, ring),
    };
  };
}

async function mapClientSecret<T extends { client_secret?: string }>(
  entity: T,
  transform: Transform,
): Promise<T> {
  if (typeof entity.client_secret !== "string") return entity;
  return {
    ...entity,
    client_secret: await transform(entity.client_secret),
  };
}

async function mapTotpSecret<T extends { totp_secret?: string }>(
  entity: T,
  transform: Transform,
): Promise<T> {
  if (typeof entity.totp_secret !== "string") return entity;
  return { ...entity, totp_secret: await transform(entity.totp_secret) };
}

async function mapConnectionOptions(
  options: Connection["options"] | undefined,
  transform: Transform,
): Promise<Connection["options"] | undefined> {
  if (!options) return options;
  const next = { ...options };
  if (typeof next.client_secret === "string") {
    next.client_secret = await transform(next.client_secret);
  }
  if (typeof next.app_secret === "string") {
    next.app_secret = await transform(next.app_secret);
  }
  if (typeof next.twilio_token === "string") {
    next.twilio_token = await transform(next.twilio_token);
  }
  if (
    next.configuration &&
    typeof next.configuration.client_secret === "string"
  ) {
    next.configuration = {
      ...next.configuration,
      client_secret: await transform(next.configuration.client_secret),
    };
  }
  return next;
}

async function mapConnection<T extends { options?: Connection["options"] }>(
  entity: T,
  transform: Transform,
): Promise<T> {
  if (!entity.options) return entity;
  return {
    ...entity,
    options: await mapConnectionOptions(entity.options, transform),
  };
}

async function mapCredentialsRecord(
  credentials: Record<string, unknown> | undefined,
  transform: Transform,
): Promise<Record<string, unknown> | undefined> {
  if (!credentials) return credentials;
  const next: Record<string, unknown> = { ...credentials };
  for (const [field, value] of Object.entries(next)) {
    if (typeof value === "string") {
      next[field] = await transform(value);
    }
  }
  return next;
}

async function mapEmailProvider<
  T extends { credentials?: Record<string, unknown> },
>(entity: T, transform: Transform): Promise<T> {
  if (!entity.credentials) return entity;
  const credentials = await mapCredentialsRecord(entity.credentials, transform);
  return { ...entity, credentials };
}

async function mapMigrationSource<
  T extends { credentials?: { client_secret?: string } },
>(entity: T, transform: Transform): Promise<T> {
  if (
    !entity.credentials ||
    typeof entity.credentials.client_secret !== "string"
  ) {
    return entity;
  }
  return {
    ...entity,
    credentials: {
      ...entity.credentials,
      client_secret: await transform(entity.credentials.client_secret),
    },
  };
}

// Action secrets are `{ name, value? }` pairs. A secret without a value (an
// update that keeps the stored value) is passed through untouched.
async function mapActionSecrets<
  T extends { secrets?: Array<{ name: string; value?: string }> },
>(entity: T, transform: Transform): Promise<T> {
  if (!entity.secrets) return entity;
  const secrets = await Promise.all(
    entity.secrets.map(async (secret) =>
      typeof secret.value === "string"
        ? { ...secret, value: await transform(secret.value) }
        : secret,
    ),
  );
  return { ...entity, secrets };
}

// Hook code secrets are a name -> value record.
async function mapHookCodeSecrets<
  T extends { secrets?: Record<string, string> },
>(entity: T, transform: Transform): Promise<T> {
  if (!entity.secrets) return entity;
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(entity.secrets)) {
    secrets[name] = typeof value === "string" ? await transform(value) : value;
  }
  return { ...entity, secrets };
}

function wrapClients(
  base: ClientsAdapter,
  codecFor: (tenantId: string) => FieldCodec,
): ClientsAdapter {
  return {
    create: async (tenant_id, params) => {
      const codec = codecFor(tenant_id);
      return mapClientSecret(
        await base.create(
          tenant_id,
          await mapClientSecret(params, codec.encrypt),
        ),
        codec.decrypt,
      );
    },
    get: async (tenant_id, client_id) => {
      const client = await base.get(tenant_id, client_id);
      return client
        ? mapClientSecret(client, codecFor(tenant_id).decrypt)
        : client;
    },
    getByClientId: async (client_id) => {
      const client = await base.getByClientId(client_id);
      // tenant_id is not an input here; decrypt is key-id driven so the tenant
      // the codec is built for only matters for encryption.
      return client
        ? mapClientSecret(client, codecFor(client.tenant_id).decrypt)
        : client;
    },
    remove: (tenant_id, client_id) => base.remove(tenant_id, client_id),
    list: async (tenant_id, params) => {
      const codec = codecFor(tenant_id);
      const result = await base.list(tenant_id, params);
      return {
        ...result,
        clients: await Promise.all(
          result.clients.map((client) =>
            mapClientSecret(client, codec.decrypt),
          ),
        ),
      };
    },
    update: async (tenant_id, client_id, client) =>
      base.update(
        tenant_id,
        client_id,
        await mapClientSecret(client, codecFor(tenant_id).encrypt),
      ),
  };
}

function wrapConnections(
  base: ConnectionsAdapter,
  codecFor: (tenantId: string) => FieldCodec,
): ConnectionsAdapter {
  return {
    create: async (tenant_id, params) => {
      const codec = codecFor(tenant_id);
      return mapConnection(
        await base.create(
          tenant_id,
          await mapConnection(params, codec.encrypt),
        ),
        codec.decrypt,
      );
    },
    remove: (tenant_id, connection_id) => base.remove(tenant_id, connection_id),
    get: async (tenant_id, connection_id) => {
      const connection = await base.get(tenant_id, connection_id);
      return connection
        ? mapConnection(connection, codecFor(tenant_id).decrypt)
        : connection;
    },
    update: async (tenant_id, connection_id, params) =>
      base.update(
        tenant_id,
        connection_id,
        await mapConnection(params, codecFor(tenant_id).encrypt),
      ),
    list: async (tenant_id, params) => {
      const codec = codecFor(tenant_id);
      const result = await base.list(tenant_id, params);
      return {
        ...result,
        connections: await Promise.all(
          result.connections.map((connection) =>
            mapConnection(connection, codec.decrypt),
          ),
        ),
      };
    },
  };
}

function wrapClientConnections(
  base: ClientConnectionsAdapter,
  codecFor: (tenantId: string) => FieldCodec,
): ClientConnectionsAdapter {
  return {
    listByClient: async (tenant_id, client_id) => {
      const codec = codecFor(tenant_id);
      const connections = await base.listByClient(tenant_id, client_id);
      return Promise.all(
        connections.map((connection) =>
          mapConnection(connection, codec.decrypt),
        ),
      );
    },
    updateByClient: (tenant_id, client_id, connection_ids) =>
      base.updateByClient(tenant_id, client_id, connection_ids),
    listByConnection: (tenant_id, connection_id) =>
      base.listByConnection(tenant_id, connection_id),
    addClientToConnection: (tenant_id, connection_id, client_id) =>
      base.addClientToConnection(tenant_id, connection_id, client_id),
    removeClientFromConnection: (tenant_id, connection_id, client_id) =>
      base.removeClientFromConnection(tenant_id, connection_id, client_id),
  };
}

function wrapEmailProviders(
  base: EmailProvidersAdapter,
  codecFor: (tenantId: string) => FieldCodec,
): EmailProvidersAdapter {
  return {
    create: async (tenant_id, emailProvider) =>
      base.create(
        tenant_id,
        await mapEmailProvider(emailProvider, codecFor(tenant_id).encrypt),
      ),
    update: async (tenant_id, emailProvider) =>
      base.update(
        tenant_id,
        await mapEmailProvider(emailProvider, codecFor(tenant_id).encrypt),
      ),
    get: async (tenant_id) => {
      const provider = await base.get(tenant_id);
      return provider
        ? mapEmailProvider(provider, codecFor(tenant_id).decrypt)
        : provider;
    },
    remove: (tenant_id) => base.remove(tenant_id),
  };
}

function wrapAuthenticationMethods(
  base: AuthenticationMethodsAdapter,
  codecFor: (tenantId: string) => FieldCodec,
): AuthenticationMethodsAdapter {
  return {
    create: async (tenant_id, method) => {
      const codec = codecFor(tenant_id);
      return mapTotpSecret(
        await base.create(
          tenant_id,
          await mapTotpSecret(method, codec.encrypt),
        ),
        codec.decrypt,
      );
    },
    get: async (tenant_id, method_id) => {
      const method = await base.get(tenant_id, method_id);
      return method
        ? mapTotpSecret(method, codecFor(tenant_id).decrypt)
        : method;
    },
    getByCredentialId: async (tenant_id, credential_id) => {
      const method = await base.getByCredentialId(tenant_id, credential_id);
      return method
        ? mapTotpSecret(method, codecFor(tenant_id).decrypt)
        : method;
    },
    list: async (tenant_id, user_id) => {
      const codec = codecFor(tenant_id);
      const methods = await base.list(tenant_id, user_id);
      return Promise.all(
        methods.map((method) => mapTotpSecret(method, codec.decrypt)),
      );
    },
    update: async (tenant_id, method_id, data) => {
      const codec = codecFor(tenant_id);
      return mapTotpSecret(
        await base.update(
          tenant_id,
          method_id,
          await mapTotpSecret(data, codec.encrypt),
        ),
        codec.decrypt,
      );
    },
    remove: (tenant_id, method_id) => base.remove(tenant_id, method_id),
  };
}

function wrapActions(
  base: ActionsAdapter,
  codecFor: (tenantId: string) => FieldCodec,
): ActionsAdapter {
  return {
    create: async (tenant_id, action, options) => {
      const codec = codecFor(tenant_id);
      return mapActionSecrets(
        await base.create(
          tenant_id,
          await mapActionSecrets(action, codec.encrypt),
          options,
        ),
        codec.decrypt,
      );
    },
    get: async (tenant_id, action_id) => {
      const action = await base.get(tenant_id, action_id);
      return action
        ? mapActionSecrets<Action>(action, codecFor(tenant_id).decrypt)
        : action;
    },
    update: async (tenant_id, action_id, action) =>
      base.update(
        tenant_id,
        action_id,
        await mapActionSecrets(action, codecFor(tenant_id).encrypt),
      ),
    remove: (tenant_id, action_id) => base.remove(tenant_id, action_id),
    list: async (tenant_id, params) => {
      const codec = codecFor(tenant_id);
      const result = await base.list(tenant_id, params);
      return {
        ...result,
        actions: await Promise.all(
          result.actions.map((action) =>
            mapActionSecrets<Action>(action, codec.decrypt),
          ),
        ),
      };
    },
  };
}

// Versions snapshot an action's secrets, values included, so they get the same
// treatment as the action itself.
function wrapActionVersions(
  base: ActionVersionsAdapter,
  codecFor: (tenantId: string) => FieldCodec,
): ActionVersionsAdapter {
  return {
    create: async (tenant_id, version, options) => {
      const codec = codecFor(tenant_id);
      return mapActionSecrets<ActionVersion>(
        await base.create(
          tenant_id,
          await mapActionSecrets(version, codec.encrypt),
          options,
        ),
        codec.decrypt,
      );
    },
    get: async (tenant_id, action_id, version_id) => {
      const version = await base.get(tenant_id, action_id, version_id);
      return version
        ? mapActionSecrets<ActionVersion>(version, codecFor(tenant_id).decrypt)
        : version;
    },
    list: async (tenant_id, action_id, params) => {
      const codec = codecFor(tenant_id);
      const result = await base.list(tenant_id, action_id, params);
      return {
        ...result,
        versions: await Promise.all(
          result.versions.map((version) =>
            mapActionSecrets<ActionVersion>(version, codec.decrypt),
          ),
        ),
      };
    },
    removeForAction: (tenant_id, action_id) =>
      base.removeForAction(tenant_id, action_id),
  };
}

function wrapHookCode(
  base: HookCodeAdapter,
  codecFor: (tenantId: string) => FieldCodec,
): HookCodeAdapter {
  return {
    create: async (tenant_id, hookCode, options) => {
      const codec = codecFor(tenant_id);
      return mapHookCodeSecrets(
        await base.create(
          tenant_id,
          await mapHookCodeSecrets(hookCode, codec.encrypt),
          options,
        ),
        codec.decrypt,
      );
    },
    get: async (tenant_id, id) => {
      const hookCode = await base.get(tenant_id, id);
      return hookCode
        ? mapHookCodeSecrets(hookCode, codecFor(tenant_id).decrypt)
        : hookCode;
    },
    update: async (tenant_id, id, hookCode) =>
      base.update(
        tenant_id,
        id,
        await mapHookCodeSecrets(hookCode, codecFor(tenant_id).encrypt),
      ),
    remove: (tenant_id, id) => base.remove(tenant_id, id),
  };
}

function wrapMigrationSources(
  base: MigrationSourcesAdapter,
  codecFor: (tenantId: string) => FieldCodec,
): MigrationSourcesAdapter {
  return {
    create: async (tenant_id, migration_source) => {
      const codec = codecFor(tenant_id);
      return mapMigrationSource(
        await base.create(
          tenant_id,
          await mapMigrationSource(migration_source, codec.encrypt),
        ),
        codec.decrypt,
      );
    },
    get: async (tenant_id, id) => {
      const source = await base.get(tenant_id, id);
      return source
        ? mapMigrationSource(source, codecFor(tenant_id).decrypt)
        : source;
    },
    list: async (tenant_id) => {
      const codec = codecFor(tenant_id);
      const sources = await base.list(tenant_id);
      return Promise.all(
        sources.map((source) => mapMigrationSource(source, codec.decrypt)),
      );
    },
    remove: (tenant_id, id) => base.remove(tenant_id, id),
    update: async (tenant_id, id, migration_source) =>
      base.update(
        tenant_id,
        id,
        await mapMigrationSource(migration_source, codecFor(tenant_id).encrypt),
      ),
  };
}

function wrapWithCodecFactory(
  data: DataAdapters,
  codecFor: (tenantId: string) => FieldCodec,
): DataAdapters {
  const wrapped: DataAdapters = {
    ...data,
    clients: wrapClients(data.clients, codecFor),
    connections: wrapConnections(data.connections, codecFor),
    clientConnections: wrapClientConnections(data.clientConnections, codecFor),
    emailProviders: wrapEmailProviders(data.emailProviders, codecFor),
    actions: wrapActions(data.actions, codecFor),
    actionVersions: wrapActionVersions(data.actionVersions, codecFor),
    hookCode: wrapHookCode(data.hookCode, codecFor),
    authenticationMethods: wrapAuthenticationMethods(
      data.authenticationMethods,
      codecFor,
    ),
    transaction: (fn) =>
      data.transaction((trx) => fn(wrapWithCodecFactory(trx, codecFor))),
  };

  if (data.migrationSources) {
    wrapped.migrationSources = wrapMigrationSources(
      data.migrationSources,
      codecFor,
    );
  }

  return wrapped;
}

/**
 * Wraps a DataAdapters instance so that sensitive credential fields are
 * transparently encrypted on write and decrypted on read. Only the adapters
 * that hold secrets are wrapped; everything else passes through unchanged.
 *
 * Encrypted columns: clients.client_secret, connections.options
 * (client_secret/app_secret/twilio_token/configuration.client_secret),
 * email_providers.credentials, authentication_methods.totp_secret,
 * migration_sources.credentials.client_secret, actions.secrets[].value,
 * action_versions.secrets[].value, hook_code.secrets values.
 *
 * clientConnections.listByClient is also wrapped so its returned Connection
 * objects are decrypted — getEnrichedClient uses this path to load connections
 * for the OAuth strategies.
 *
 * Private keys (keys.pkcs7, dkim_private_key) are intentionally NOT covered.
 */
export function createEncryptedDataAdapter(
  data: DataAdapters,
  key: CryptoKey,
): DataAdapters {
  return wrapWithCodecFactory(data, makeCodecFactory({ default: key }));
}

/**
 * Like {@link createEncryptedDataAdapter}, but encrypts each tenant's secrets
 * under a key selected from a {@link KeyRing}. On read, the key is chosen from
 * the id embedded in the ciphertext, so a single database can mix values
 * encrypted under different keys.
 *
 * `options.resolveEncryptKeyId(tenantId)` decides which key id new ciphertext is
 * tagged with. Return `undefined` for the ring's default key (legacy untagged
 * form). The intended use is to tag control plane tenant rows with a
 * control-plane-only key id so an inheriting tenant can hold the inherited
 * secrets at rest without being able to decrypt them.
 *
 * @example
 * ```typescript
 * const adapters = createEncryptedDataAdapterWithKeyRing(base, {
 *   default: tenantKey,
 *   keys: { cp: controlPlaneKey },
 * }, {
 *   resolveEncryptKeyId: (tenantId) =>
 *     tenantId === CONTROL_PLANE_TENANT_ID ? "cp" : undefined,
 * });
 * ```
 */
export function createEncryptedDataAdapterWithKeyRing(
  data: DataAdapters,
  ring: KeyRing,
  options: EncryptionOptions = {},
): DataAdapters {
  return wrapWithCodecFactory(
    data,
    makeCodecFactory(ring, options.resolveEncryptKeyId),
  );
}
