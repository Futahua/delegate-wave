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
import test from "node:test";
import { HermesMcpAdapter } from "../src/mcp/server.js";

const META_KEY = "io.delegate-wave/hermes-session-id";

// A control client that records what would have been posted, so these tests are
// about the boundary rather than about HTTP.
function recordingAdapter() {
  const posts = [];
  const client = {
    async get() { return []; },
    async post(path, body, requestId) { posts.push({ path, body, requestId }); return { id: "asess_x" }; },
  };
  return { adapter: new HermesMcpAdapter({ client }), posts };
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

test("two conversations through ONE shared server get their own identities", async () => {
  // THE REASON THIS IS PER-CALL METADATA AND NOT AN ENVIRONMENT VARIABLE.
  //
  // The stdio subprocess is spawned once and outlives any single conversation,
  // so anything baked into its environment would address every session's answer
  // to whichever chat happened to start it. Per-call meta is the only boundary
  // that tracks the caller.
  const { adapter, posts } = recordingAdapter();
  await adapter.callTool("session_start", { project_id: "p", intent: "first" },
    { [META_KEY]: "session_AAA" });
  await adapter.callTool("session_start", { project_id: "p", intent: "second" },
    { [META_KEY]: "session_BBB" });

  assert.deepEqual(posts.map((p) => p.body.hermesSessionId), ["session_AAA", "session_BBB"]);
  assert.notEqual(posts[0].requestId, posts[1].requestId, "and each is a distinct intent");
});

test("a model cannot smuggle its own address past the client's", async () => {
  // If the two disagree, somebody is wrong about who is waiting. Picking either
  // one silently is how an answer arrives in the wrong conversation.
  const { adapter } = recordingAdapter();
  await assert.rejects(
    adapter.callTool(
      "session_start",
      { project_id: "p", intent: "x", hermes_session_id: "session_ATTACKER" },
      { [META_KEY]: "session_REAL" },
    ),
    /conflicts with the calling session's identity/,
  );
});

test("an agreeing explicit id is not treated as a conflict", async () => {
  // A scripted caller that passes the same value both ways is not doing anything
  // wrong, and breaking it would be gratuitous.
  const { adapter, posts } = recordingAdapter();
  await adapter.callTool(
    "session_start",
    { project_id: "p", intent: "x", hermes_session_id: "session_SAME" },
    { [META_KEY]: "session_SAME" },
  );
  assert.equal(posts[0].body.hermesSessionId, "session_SAME");
});

test("a direct caller may still supply it explicitly", async () => {
  // Manual and scripted use predates this and is not worth breaking; what is no
  // longer allowed is starting work with NO address at all.
  const { adapter, posts } = recordingAdapter();
  await adapter.callTool("session_start", { project_id: "p", intent: "x", hermes_session_id: "manual_1" }, {});
  assert.equal(posts[0].body.hermesSessionId, "manual_1");
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

test("meta reaching the adapter is not optional plumbing", async () => {
  // Guards the boundary that actually broke: runMcpStdio used to pass only
  // `arguments`, so every call arrived with its caller context already discarded
  // and session_start could never have seen it.
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/mcp/server.js", import.meta.url), "utf8"));
  const call = source.slice(source.indexOf("adapter.callTool("), source.indexOf("adapter.callTool(") + 260);
  assert.match(call, /_meta/, "the stdio boundary drops caller metadata again");
});
