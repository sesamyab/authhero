import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { env } from "./env";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const APPS_DIR = path.join(REPO_ROOT, "apps");
const AUTH_SERVER_NAME = "conformance-auth-server";
export const AUTH_SERVER_DIR = path.join(APPS_DIR, AUTH_SERVER_NAME);
export const AUTH_SERVER_CERT_DIR = path.join(AUTH_SERVER_DIR, ".certs");
export const AUTH_SERVER_KEY_PATH = path.join(
  AUTH_SERVER_CERT_DIR,
  "localhost-key.pem",
);
export const AUTH_SERVER_CERT_PATH = path.join(
  AUTH_SERVER_CERT_DIR,
  "localhost.pem",
);
const SCAFFOLDER = path.join(
  REPO_ROOT,
  "packages/create-authhero/dist/create-authhero.js",
);

function run(cmd: string, args: string[], cwd: string = REPO_ROOT): void {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.signal) {
    throw new Error(
      `Command killed by signal ${result.signal}: ${cmd} ${args.join(" ")}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Command failed (exit ${result.status}): ${cmd} ${args.join(" ")}`,
    );
  }
}

// Kill anything still bound to port 3000 before we wipe the auth-server
// directory. A `tsx watch` left over from a previous (failed/cancelled) run
// has its cwd inside conformance-auth-server; deleting that cwd out from
// under it crashes the watcher with "ENOENT: no such file or directory,
// uv_cwd" while it's mid-recompile, which then surfaces in the next run's
// webServer logs and confuses the failure mode.
function killStaleAuthServer(): void {
  const lsof = spawnSync(
    "lsof",
    ["-nP", "-iTCP:3000", "-sTCP:LISTEN", "-t"],
    { encoding: "utf-8" },
  );
  if (lsof.status !== 0 || !lsof.stdout.trim()) return;
  const pids = lsof.stdout.trim().split(/\s+/).filter(Boolean);
  console.log(
    `[conformance-runner] Killing stale auth-server process(es) on port 3000: ${pids.join(", ")}`,
  );
  for (const pid of pids) {
    spawnSync("kill", ["-9", pid]);
  }
}

function scaffoldAuthServer(): void {
  if (!fs.existsSync(SCAFFOLDER)) {
    throw new Error(
      `Scaffolder not built at ${SCAFFOLDER}. Run \`pnpm --filter create-authhero build\` first.`,
    );
  }
  killStaleAuthServer();
  if (fs.existsSync(AUTH_SERVER_DIR)) {
    console.log(
      `[conformance-runner] Wiping previous ${AUTH_SERVER_NAME}...`,
    );
    fs.rmSync(AUTH_SERVER_DIR, { recursive: true, force: true });
  }
  console.log(`[conformance-runner] Scaffolding ${AUTH_SERVER_NAME}...`);
  // Run from apps/ so the scaffolder writes into apps/<AUTH_SERVER_NAME>/.
  // --skip-install/--skip-migrate because the workspace-root pnpm install
  // below is what wires up workspace:* deps; the scaffolder's per-project
  // install is incompatible with workspace-protocol references.
  run(
    "node",
    [
      SCAFFOLDER,
      AUTH_SERVER_NAME,
      "--yes",
      "--template",
      "local",
      "--workspace",
      "--skip-install",
      "--skip-migrate",
      "--skip-start",
      // --conformance injects a `default_audience: "urn:authhero:management"`
      // assignment on the seeded tenant. Without it, the OIDC code flow's
      // /token call (which doesn't pass an `audience` parameter) is rejected
      // with "An audience must be specified in the request or configured as
      // the tenant default_audience".
      "--conformance",
      "--conformance-alias",
      env.alias,
    ],
    APPS_DIR,
  );

  console.log(
    "[conformance-runner] Installing workspace deps (pnpm install)...",
  );
  run("pnpm", ["install"], REPO_ROOT);
}

function ensureAuthServerCert(): void {
  if (
    fs.existsSync(AUTH_SERVER_CERT_PATH) &&
    fs.existsSync(AUTH_SERVER_KEY_PATH)
  ) {
    return;
  }
  fs.mkdirSync(AUTH_SERVER_CERT_DIR, { recursive: true });
  console.log(
    "[conformance-runner] Generating self-signed cert for auth-server...",
  );
  // SAN covers both names the auth-server is reached as:
  //   - localhost: Playwright's host-side health check, and the user's
  //     /etc/hosts also maps host.docker.internal → 127.0.0.1.
  //   - host.docker.internal: the suite container's hostname for the host
  //     gateway, and the canonical issuer published in discovery.
  const san = "subjectAltName=DNS:localhost,DNS:host.docker.internal";
  run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    AUTH_SERVER_KEY_PATH,
    "-out",
    AUTH_SERVER_CERT_PATH,
    "-days",
    "365",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-addext",
    san,
  ]);
}


// Runs at playwright.config.ts module-load time, BEFORE Playwright spawns its
// webServer plugin. This is necessary because Playwright's plugin setup tasks
// run before globalSetup, so anything that has to exist before `npm run dev`
// is spawned (the auth-server directory, its node_modules, a seeded DB, the
// HTTPS cert, plus the conformance-suite docker stack the suite-side tests
// hit) must be in place by the time defineConfig returns.
// Sentinel env var that propagates from the orchestrator to forked test
// workers via the inherited environment. Without this guard, every worker
// re-importing playwright.config.ts would re-run prepareAuthServer —
// killing the orchestrator's running auth-server, wiping its directory,
// and re-scaffolding without ever starting a webServer (only the
// orchestrator's plugin does that). Net effect: tests run with no
// auth-server.
const PREPARED_ENV = "PW_CONFORMANCE_AUTH_SERVER_PREPARED";

export function prepareAuthServer(): void {
  if (process.env[PREPARED_ENV] === "1") {
    return;
  }
  if (env.skipSetup) {
    console.log(
      "[conformance-runner] SKIP_SETUP=1 — skipping scaffold + docker + seed",
    );
    process.env[PREPARED_ENV] = "1";
    return;
  }
  scaffoldAuthServer();
  console.log("[conformance-runner] Starting conformance suite...");
  run("pnpm", ["conformance:start"]);
  if (env.httpsEnabled) {
    ensureAuthServerCert();
  }
  console.log("[conformance-runner] Reseeding auth-server database...");
  run("pnpm", ["conformance:seed"]);
  process.env[PREPARED_ENV] = "1";
}
