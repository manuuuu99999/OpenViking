import { buildPluginConfig } from "./shared/plugin-config.mjs";
import { CREDENTIAL_ENV_VARS, loadCredentialFiles } from "./shared/credentials.mjs";

export const PLUGIN_VERSION = "0.5.27";

/**
 * Namespace for the bridged OpenViking MCP tools. DSH publishes every MCP tool
 * as `mcp__<serverName>__<rawName>`, so this string is part of the
 * model-facing contract: changing it renames all of them.
 */
export const MCP_SERVER_NAME = "openviking";
export const MCP_HISTORY_SERVER_NAME = "openviking_history";

/**
 * Resolve the plugin's configuration.
 *
 * `input` is what the cordis host hands the plugin — this harness has no config
 * file of its own. Every knob is declared in `shared/config-schema.mjs`, and
 * `ovcli.conf`'s `plugin` section outranks the host's input so one file
 * configures every harness and `ov config switch` moves them together.
 * Connection fields are the exception: an endpoint, key, identity or auth mode
 * named by the host is the more specific answer and stays ahead of the
 * credential chain.
 */
export function resolveConfig(input = {}, env = process.env, cwd = process.cwd()) {
  // ov.conf's `dsh` section is the legacy layer here as everywhere else, but
  // the cordis patch shares that slot; the host named this process's settings,
  // so it wins the overlap.
  // Route credentials are explicit host inputs, not behavioral knobs read from
  // shared configuration files. Keep the candidate connection inside the common
  // connection resolver so it reports the same provenance as other host inputs.
  const memoryIsolation = Object.prototype.hasOwnProperty.call(input, "memoryIsolation")
    ? normalizeMemoryIsolation(input.memoryIsolation)
    : null;
  const candidate = memoryIsolation?.candidate;
  const ovSection = loadCredentialFiles(env).ovFile.dsh;
  const config = buildPluginConfig("dsh", {
    env,
    cwd,
    legacy: { ...(ovSection && typeof ovSection === "object" ? ovSection : {}), ...input },
    version: PLUGIN_VERSION,
    hostInput: {
      peerId: input.peerId,
      account: candidate?.account ?? input.account,
      user: candidate?.user ?? input.user,
      apiKey: candidate?.apiKey ?? input.apiKey,
      baseUrl: candidate?.endpoint ?? input.endpoint,
      // The legacy knob layer this used to ride accepted both spellings.
      authMode: candidate?.authMode ?? input.authMode ?? input.auth_mode,
    },
    deriveEffectivePeer: true,
  });
  return {
    ...config,
    peerId: config.effectivePeer.peerId,
    ...(memoryIsolation ? { memoryIsolation } : {}),
  };
}

const MEMORY_ROLES = ["candidate", "approved", "history"];

function normalizeMemoryIsolation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("memoryIsolation must define candidate, approved, and history routes.");
  }

  const errors = [];
  const routes = {};
  for (const role of MEMORY_ROLES) {
    const source = value[role];
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      errors.push(`${role} route is missing`);
      continue;
    }
    const endpoint = typeof source.endpoint === "string" ? source.endpoint.trim().replace(/\/+$/, "") : "";
    const apiKey = typeof source.apiKey === "string" ? source.apiKey.trim() : "";
    const account = typeof source.account === "string" ? source.account.trim() : "";
    const user = typeof source.user === "string" ? source.user.trim() : "";
    if (!endpoint) errors.push(`${role}.endpoint is required`);
    if (!apiKey) errors.push(`${role}.apiKey is required`);
    if (!account) errors.push(`${role}.account is required`);
    if (!user) errors.push(`${role}.user is required`);
    if (endpoint) {
      let parsed;
      try {
        parsed = new URL(endpoint);
      } catch {
        errors.push(`${role}.endpoint must be an HTTP(S) URL`);
      }
      if (parsed && !["http:", "https:"].includes(parsed.protocol)) {
        errors.push(`${role}.endpoint must be an HTTP(S) URL`);
      }
    }
    routes[role] = {
      endpoint,
      baseUrl: endpoint,
      apiKey,
      account,
      user,
      authMode: "api_key",
      sendIdentityHeaders: false,
    };
  }

  const keys = MEMORY_ROLES.map(role => routes[role]?.apiKey).filter(Boolean);
  if (new Set(keys).size !== keys.length) errors.push("each route must use a distinct apiKey");
  if (errors.length) {
    throw new TypeError(`memoryIsolation requires complete candidate, approved, and history routes: ${errors.join("; ")}.`);
  }
  return routes;
}
