// In-memory stand-in for the OpenViking routes the proposal tools use. Test support only:
// it models per-identity read access, ACL-restricted resources and injectable failures.

const APPROVED_SEGMENT = "/approved/";
const HISTORY_SEGMENT = "/history/";

export function createFakeOpenViking({ account = "project-a" } = {}) {
  const resources = new Map();
  const candidateFiles = new Map();
  const calls = [];
  const failures = [];
  const state = { aclEnabled: true };

  const respond = (ok, status, extra = {}) => (ok
    ? { ok: true, status, result: extra.result ?? {} }
    : { ok: false, status, result: null, error: { code: extra.code || "ERROR" } });

  function matchFailure(identity, method, uri) {
    const index = failures.findIndex(failure => (
      failure.method === method && (!failure.uriIncludes || uri?.includes(failure.uriIncludes))
    ));
    return index < 0 ? null : failures.splice(index, 1)[0];
  }

  function client(user, canRead) {
    return {
      config: { account, user },
      async fetchJSON(path, init = {}) {
        const request = new URL(`http://fixture${path}`);
        const uri = request.searchParams.get("uri");
        const method = init.method || "GET";
        calls.push({ identity: user, method, path, uri, body: init.body });
        if (method === "GET" && request.pathname === `/api/v1/admin/accounts/${account}/settings`) {
          return respond(true, 200, { result: { settings: { acl: { enabled: state.aclEnabled } } } });
        }
        if (method === "GET" && request.pathname === "/api/v1/content/read") {
          const failure = matchFailure(user, "GET", uri);
          if (failure?.aborted) return { ok: false, status: 0, error: { name: "AbortError", aborted: true } };
          if (failure?.network) return { ok: false, status: 0, error: { message: "network unreachable" } };
          if (failure) return respond(false, failure.status || 500, { code: failure.code || "INTERNAL" });
          if (candidateFiles.has(uri) && user === "candidate") return respond(true, 200, { result: candidateFiles.get(uri) });
          if (!canRead(uri)) return respond(false, 403, { code: "PERMISSION_DENIED" });
          if (!resources.has(uri)) return respond(false, 404, { code: "NOT_FOUND" });
          return respond(true, 200, { result: resources.get(uri).content });
        }
        if (method === "POST" && request.pathname === "/api/v1/content/write") {
          const body = JSON.parse(init.body);
          const failure = matchFailure(user, "POST", body.uri);
          if (failure && !failure.applyBeforeFailing) return respond(false, failure.status || 500, { code: "INTERNAL" });
          if (body.mode === "create" && resources.has(body.uri)) return respond(false, 409, { code: "ALREADY_EXISTS" });
          resources.set(body.uri, { content: body.content, acl: body.acl });
          if (failure) return respond(false, 0, { code: "NETWORK_ERROR" });
          return respond(true, 200, { result: { uri: body.uri } });
        }
        if (method === "DELETE" && request.pathname === "/api/v1/fs") {
          const failure = matchFailure(user, "DELETE", uri);
          if (failure && !failure.applyBeforeFailing) return respond(false, failure.status || 500, { code: "INTERNAL" });
          const existed = resources.delete(uri);
          if (failure) return respond(false, 0, { code: "NETWORK_ERROR" });
          return existed ? respond(true, 200, { result: { uri } }) : respond(false, 404, { code: "NOT_FOUND" });
        }
        return respond(false, 404, { code: "NOT_FOUND" });
      },
    };
  }

  return {
    state,
    calls,
    resources,
    candidateFiles,
    candidate: client("candidate", () => false),
    approved: client("approved", uri => uri?.includes(APPROVED_SEGMENT)),
    history: client("history", uri => uri?.includes(HISTORY_SEGMENT)),
    // The publisher may write and delete but must never read content.
    publisher: client("publisher-admin", () => false),
    failNext(failure) {
      failures.push(failure);
    },
    callsBy(identity, method) {
      return calls.filter(call => call.identity === identity && (!method || call.method === method));
    },
    clearCalls() {
      calls.length = 0;
    },
    normalReadable() {
      return [...resources.entries()]
        .filter(([uri]) => uri.includes(APPROVED_SEGMENT))
        .map(([uri, value]) => ({ uri, content: value.content }));
    },
  };
}
