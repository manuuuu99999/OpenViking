import { fileURLToPath } from "node:url";

import { MCP_HISTORY_SERVER_NAME, MCP_SERVER_NAME } from "./config.mjs";
import { forwardConnectionEnv } from "./shared/mcp-proxy-config.mjs";

/** The same stdio proxy every other OpenViking memory integration starts. */
export const PROXY_PATH = fileURLToPath(new URL("./servers/mcp-proxy.mjs", import.meta.url));

/** Tools exposed on the approved and history routes; the proxy enforces this too. */
export const READ_ONLY_MCP_TOOLS = Object.freeze([
  "find", "search", "read", "list", "tree", "grep", "glob", "health",
]);

/**
 * Build the dsh-mcp-client config for the OpenViking stdio proxy.
 *
 * DSH scrubs credential-shaped names out of the environment a subprocess
 * inherits, and the Cordis patch is invisible to one, so the proxy cannot
 * resolve the connection the way this process did. It gets the answer instead:
 * the resolved connection, diagnostics, and this session's peer, forwarded
 * with the forced `env` source so the child reads no file and lands on exactly
 * these values — the empty ones included.
 */
export function buildMcpConfig(config, { role, serverName } = {}) {
  let connection = config;
  let restricted = false;
  let selectedRole = role;
  if (config.memoryIsolation) {
    selectedRole ||= "approved";
    if (selectedRole === "candidate") {
      throw new Error("The candidate route must never be exposed to MCP tools.");
    }
    if (!["approved", "history"].includes(selectedRole)) {
      throw new Error(`Unknown memoryIsolation tool route: ${selectedRole}.`);
    }
    const route = config.memoryIsolation[selectedRole];
    connection = {
      ...config,
      ...route,
      mcpUrl: `${route.endpoint}/mcp`,
    };
    restricted = true;
  } else if (role) {
    throw new Error("A role-specific MCP route requires memoryIsolation configuration.");
  }

  // In DSH Desktop, process.execPath is Electron's executable rather than a
  // standalone Node binary. This tells Electron to run the proxy script as
  // Node instead of attempting to launch a second Desktop instance.
  const env = {
    ELECTRON_RUN_AS_NODE: "1",
    ...forwardConnectionEnv(connection),
    OPENVIKING_DEBUG: config.debug ? "1" : "0",
    OPENVIKING_DEBUG_LOG: config.debugLogPath || "",
  };
  if (config.recallPeerScope) env.OPENVIKING_RECALL_PEER_SCOPE = config.recallPeerScope;
  if (config.timeoutMs) env.OPENVIKING_TIMEOUT_MS = String(config.timeoutMs);
  if (restricted) {
    env.OPENVIKING_MCP_ALLOWED_TOOLS = READ_ONLY_MCP_TOOLS.join(",");
    if (selectedRole === "history") {
      env.OPENVIKING_MCP_TOOL_DESCRIPTION_PREFIX = "HISTORY ROUTE: archived context is not current approved knowledge; use only for deliberate historical lookup.";
    }
  }
  return {
    transport: "stdio",
    serverName: serverName || (selectedRole === "history" ? MCP_HISTORY_SERVER_NAME : MCP_SERVER_NAME),
    command: process.execPath,
    args: [PROXY_PATH],
    env,
    toolCallTimeoutMs: config.mcpToolCallTimeoutMs,
  };
}
