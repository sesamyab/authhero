export {
  createAccessControlHooks,
  validateTenantAccess,
} from "./access-control";
export { createDatabaseHooks, type DatabaseFactory } from "./database";
export { createProvisioningHooks } from "./provisioning";
export {
  createSyncHooks,
  type EntitySyncConfig,
  type SyncHooksResult,
} from "./sync";
export {
  createSelfServiceSignupHooks,
  chainSelfServiceHooks,
  DEFAULT_SELF_SERVICE_ROLE_NAME,
  type SelfServiceSignupConfig,
} from "./self-service-signup";
