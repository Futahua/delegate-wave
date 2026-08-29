// Where the answer goes, and who is allowed to decide it.
//
// session_start once took the calling conversation's id as an optional MODEL
// argument, described as "omit it and nobody is told when it ends". A model
// omitted it. The work ran to completion and reported to no one, which from the
// outside is indistinguishable from success until somebody asks why they were
// never told.
//
// The address is transport context. The client stamps it into `_meta` from the
// session identity already bound to its turn, and the model never sees it.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { HermesMcpAdapter, runMcpStdio } from "../src/mcp/server.js";

const META_KEY = "io.delegate-wave/hermes-session-id";

// A control client that records what would have been posted, so these tests are
// about the boundary rather than about HTTP.
function recordingAdapter() {
  const posts = [];
  const client = {
    async get() { return []; },
    async post(path, body, requestId) { posts.push({ path, body, requestId }); return { id: "asess_x" }; },
  };
  return { adapter: new HermesMcpAdapter({ client }), client, posts };
}

function delayedRecordingAdapter() {
  const posts = [];
  const client = {
    async get() { return []; },
    async post(path, body, requestId) {
      await new Promise((resolve) => setTimeout(resolve, body.intent === "first" ? 15 : 0));
      posts.push({ path, body, requestId });
      return { id: `asess_${body.intent}` };
    },
  };
  return { adapter: new HermesMcpAdapter({ client }), client, posts };
}

test("the model is not offered a callback address at all", () => {
  // The strongest form of "a model cannot get this wrong": it is not in the
  // schema, so there is nothing to fill in, omit, or invent.
  const { adapter } = recordingAdapter();
  const start = adapter.listTools().find((tool) => tool.name === "session_start");
  const properties = start.inputSchema.properties;
  assert.equal(properties.hermes_session_id, undefined,
    "session_start still advertises a session id the model would have to supply");
  assert.deepEqual(start.inputSchema.required, ["project_id", "intent"]);
  assert.equal(start.inputSchema.additionalProperties, false);
});

test("the calling conversation's id comes from meta", async () => {
  const { adapter, posts } = recordingAdapter();
  await adapter.callTool(
    "session_start",
    { project_id: "proj", intent: "do the thing" },
    { [META_KEY]: "20260827_104900_22948f" },
  );
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.hermesSessionId, "20260827_104900_22948f");
});

test("two simultaneous conversations through ONE shared server never swap identities", async () => {
  // THE REASON THIS IS PER-CALL METADATA AND NOT AN ENVIRONMENT VARIABLE.
  //
  // The stdio subprocess is spawned once and outlives any single conversation,
  // so anything baked into its environment would address every session's answer
  // to whichever chat happened to start it. Per-call meta is the only boundary
  // that tracks the caller.
  const { adapter, posts } = delayedRecordingAdapter();
  await Promise.all([
    adapter.callTool("session_start", { project_id: "p", intent: "first" },
      { [META_KEY]: "session_AAA" }),
    adapter.callTool("session_start", { project_id: "p", intent: "second" },
      { [META_KEY]: "session_BBB" }),
  ]);

  assert.deepEqual(
    Object.fromEntries(posts.map((p) => [p.body.intent, p.body.hermesSessionId])),
    { first: "session_AAA", second: "session_BBB" },
  );
  assert.notEqual(posts[0].requestId, posts[1].requestId, "and each is a distinct intent");
});

test("a fake argument cannot override the transport identity", async () => {
  const { adapter, posts } = recordingAdapter();
  await adapter.callTool(
    "session_start",
    { project_id: "p", intent: "x", hermes_session_id: "session_ATTACKER" },
    { [META_KEY]: "session_REAL" },
  );
  assert.equal(posts[0].body.hermesSessionId, "session_REAL");
});

test("no address at all refuses to start work rather than working silently", async () => {
  // The failure this whole change exists to remove. Silence used to be the
  // default; it now costs a visible error instead of a session nobody watches.
  const { adapter, posts } = recordingAdapter();
  await assert.rejects(
    adapter.callTool("session_start", { project_id: "p", intent: "x" }, {}),
    /Refusing to start work nobody is watching/,
  );
  assert.equal(posts.length, 0, "and nothing was started");
});

test("invalid caller metadata refuses before the control POST", async () => {
  for (const value of ["", "   ", 7, {}, []]) {
    const { adapter, posts } = recordingAdapter();
    await assert.rejects(
      adapter.callTool(
        "session_start",
        { project_id: "p", intent: "x" },
        { [META_KEY]: value },
      ),
      /as a non-empty string/,
    );
    assert.equal(posts.length, 0, `invalid metadata ${JSON.stringify(value)} reached the control API`);
  }
});

test("an argument-only address cannot turn an MCP call into an unwatched internal start", async () => {
  const { adapter, posts } = recordingAdapter();
  await assert.rejects(
    adapter.callTool(
      "session_start",
      { project_id: "p", intent: "x", hermes_session_id: "manual_1" },
      {},
    ),
    /Refusing to start work nobody is watching/,
  );
  assert.equal(posts.length, 0);
});

test("the real stdio tools/call boundary carries request params _meta", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let response = "";
  output.on("data", (chunk) => { response += chunk.toString(); });
  const { posts, client } = recordingAdapter();
  const lines = runMcpStdio({ input, output, client });

  input.end(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "session_start",
      arguments: { project_id: "p", intent: "via stdio" },
      _meta: { [META_KEY]: "session_STDIO" },
    },
  })}\n`);
  for (let index = 0; index < 100 && !response.trim(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  lines.close();

  assert.equal(JSON.parse(response.trim()).result.isError, false);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.hermesSessionId, "session_STDIO");
});
