import { boundContextSummary } from "@deepseek-ai/dsh-llm";
import { pluginMessage } from "./capture.mjs";
import { MCP_HISTORY_SERVER_NAME, MCP_SERVER_NAME } from "./config.mjs";
import { addSkillExample, evaluateUriGuard, evaluateUriNotice, isSkillUri } from "./shared/uri-guard.mjs";

/** Model-facing name of a bridged OpenViking MCP tool. */
const mcp = rawName => `mcp__${MCP_SERVER_NAME}__${rawName}`;

const GUARDED_TOOLS = {
  read: {
    tool: mcp("read"),
    example: uri => `${mcp("read")}(uris="${uri}")`,
  },
  glob: {
    tool: mcp("list"),
    example: uri => `${mcp("list")}(uri="${uri}")`,
  },
  grep: {
    tool: mcp("grep"),
    example: (uri, args) =>
      `${mcp("grep")}(pattern="${escapeText(args?.pattern)}", uri="${uri}")`,
  },
  bash: {
    tool: `${mcp("read")} or ${mcp("search")}`,
    example: uri => `${mcp("read")}(uris="${uri}")`,
  },
  edit: {
    tool: uri => (isSkillUri(uri) ? mcp("add_skill") : mcp("edit")),
    example: uri =>
      isSkillUri(uri)
        ? addSkillExample(uri, { call: mcp("add_skill"), edited: true })
        : `${mcp("edit")}(uri="${uri}", old_string="...", new_string="...")`,
  },
  write: {
    tool: uri => (isSkillUri(uri) ? mcp("add_skill") : mcp("write")),
    example: uri =>
      isSkillUri(uri)
        ? addSkillExample(uri, { call: mcp("add_skill") })
        : `${mcp("write")}(uri="${uri}", content="...")`,
  },
  str_replace_editor: {
    tool: "the OpenViking MCP tools",
    example: uri => `${mcp("read")}(uris="${uri}")`,
  },
};

export async function guardVikingUri(exec, next) {
  const decision = evaluateUriGuard(exec.name, exec.arguments, { hints: GUARDED_TOOLS });
  if (!decision) return next();
  return { kind: "deny", reason: decision.reason };
}

// Delegates first so a later listener's block or content replacement survives;
// notices only ride along as additional context.
export async function noticeVikingUri(exec, _result, next) {
  const notice = evaluateUriNotice(exec.name, exec.arguments, { hints: GUARDED_TOOLS });
  const isHistoryRoute = String(exec?.name || "").startsWith(`mcp__${MCP_HISTORY_SERVER_NAME}__`);
  if (!notice && !isHistoryRoute) return next();
  const decision = await next();
  const additionalContexts = [...(decision.additionalContexts ?? [])];
  if (notice) {
    additionalContexts.push(pluginMessage(notice.reason, {
      form: "notice",
      summary: boundContextSummary(`OpenViking URI guard: shell command contains ${notice.uri}`),
    }));
  }
  if (isHistoryRoute) {
    additionalContexts.push(pluginMessage(
      "AVISO: Este resultado procede de la vía histórica de OpenViking. No es conocimiento vigente aprobado. Úsalo solo para consulta histórica deliberada y coteja el original antes de afirmarlo.",
      {
        form: "notice",
        route: "history",
        summary: boundContextSummary("OpenViking history result is archived, not current approved knowledge."),
      },
    ));
  }
  return { ...decision, additionalContexts };
}

function escapeText(value) {
  return String(value || "").replaceAll('"', '\\"');
}
