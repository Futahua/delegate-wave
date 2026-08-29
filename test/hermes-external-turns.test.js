import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ExternalTurnError,
  HermesExternalTurns,
  replaceLoneSurrogates,
} from "../src/session/hermes-external-turns.js";

const PYTHON = process.env.DELEGATE_WAVE_HERMES_PYTHON
  || (process.platform === "win32" ? "python" : "python3");

async function fakeHermes() {
  const root = await mkdtemp(path.join(os.tmpdir(), "dw-hermes-ext-"));
  const tools = path.join(root, "tools");
  const log = path.join(root, "calls.jsonl");
  await mkdir(tools);
  await writeFile(path.join(tools, "__init__.py"), "", "utf8");
  await writeFile(path.join(tools, "session_external_turns.py"), `
import json, os, time
SESSION_EXTERNAL_TURNS_V1 = True
LOG = os.environ["FAKE_HERMES_LOG"]
def record(op, payload):
    with open(LOG, "a", encoding="utf-8") as stream:
        stream.write(json.dumps({"op": op, **payload}, ensure_ascii=False) + "\\n")
def enqueue_external_turn(**kwargs):
    record("enqueue", kwargs)
    return os.environ.get("FAKE_ENQUEUE_RESULT", "true") == "true"
def get_external_turn(event_id):
    if os.environ.get("FAKE_GET_SLEEP"):
        time.sleep(float(os.environ["FAKE_GET_SLEEP"]))
    record("get", {"event_id": event_id})
    return None if os.environ.get("FAKE_GET_NULL") == "1" else {
        "event_id": event_id, "state": "PENDING", "owner_alive": False,
    }
def reopen_external_turn(event_id, reason=""):
    record("reopen", {"event_id": event_id, "reason": reason})
    return True
`, "utf8");
  return { root, log };
}

async function calls(log) {
  try {
    return (await readFile(log, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

test("external-turn bridge maps all Hermes module operations through JSON stdin", async () => {
  const fake = await fakeHermes();
  const adapter = new HermesExternalTurns({
    command: PYTHON,
    cwd: fake.root,
    env: { ...process.env, FAKE_HERMES_LOG: fake.log, FAKE_ENQUEUE_RESULT: "false" },
  });
  const body = "quotes \" and newline\nvalid 😃 lone \uDC9D";

  assert.equal(await adapter.present(), true);
  assert.equal(await adapter.enqueue({ eventId: "wake_1", sessionKey: "S 1", body }), false);
  assert.deepEqual(await adapter.get("wake_1"), {
    event_id: "wake_1", state: "PENDING", owner_alive: false,
  });
  assert.equal(await adapter.reopen("wake_1", "owner died"), true);

  assert.deepEqual(await calls(fake.log), [
    {
      op: "enqueue", event_id: "wake_1", target_session_key: "S 1",
      body: replaceLoneSurrogates(body), source: "delegate-wave",
    },
    { op: "get", event_id: "wake_1" },
    { op: "reopen", event_id: "wake_1", reason: "owner died" },
  ]);
});

test("external-turn bridge preserves explicit source and null status", async () => {
  const fake = await fakeHermes();
  const adapter = new HermesExternalTurns({
    command: PYTHON,
    cwd: fake.root,
    env: { ...process.env, FAKE_HERMES_LOG: fake.log, FAKE_GET_NULL: "1" },
  });
  assert.equal(await adapter.enqueue({
    eventId: "wake_2", sessionKey: "S2", body: "done", source: "delegate-wave-test",
  }), true);
  assert.equal(await adapter.status("missing"), null);
  assert.equal((await calls(fake.log))[0].source, "delegate-wave-test");
});

test("external-turn bridge fails closed for an incompatible Hermes interpreter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dw-hermes-bad-"));
  const adapter = new HermesExternalTurns({ command: PYTHON, cwd: root });
  await assert.rejects(adapter.present(), (error) => {
    assert.ok(error instanceof ExternalTurnError);
    assert.equal(error.op, "present");
    assert.match(error.message, /ModuleNotFoundError|No module named/);
    return true;
  });
});

test("external-turn bridge bounds an unresponsive Hermes call", async () => {
  const fake = await fakeHermes();
  const adapter = new HermesExternalTurns({
    command: PYTHON,
    cwd: fake.root,
    env: { ...process.env, FAKE_HERMES_LOG: fake.log, FAKE_GET_SLEEP: "2" },
    timeoutMs: 50,
  });
  await assert.rejects(adapter.get("wake_slow"), (error) => {
    assert.ok(error instanceof ExternalTurnError);
    assert.equal(error.op, "status");
    assert.match(error.message, /timed out/);
    return true;
  });
});

test("external-turn framing replaces lone surrogates but preserves valid pairs", () => {
  const smile = "\uD83D\uDE03";
  assert.equal(
    replaceLoneSurrogates(`before\uDC9Dmiddle${smile}after\uD800`),
    `before\uFFFDmiddle${smile}after\uFFFD`,
  );
});
