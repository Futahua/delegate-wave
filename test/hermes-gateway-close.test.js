import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { HermesGateway } from "../src/session/hermes-gateway.js";

function childDouble({ forceError = null } = {}) {
  const child = new EventEmitter();
  child.pid = 42424;
  child.stdin = { end() {} };
  child.signals = [];
  child.kill = (signal = "SIGTERM") => {
    child.signals.push(signal);
    if (signal === "SIGKILL" && forceError) throw forceError;
    return true;
  };
  return child;
}

test("close remains pending after force kill until child exit is observed", async () => {
  const gateway = new HermesGateway({ closeGraceMs: 0 });
  const child = childDouble();
  gateway.child = child;
  let resolved = false;
  const closing = gateway.close().then(() => { resolved = true; });

  await new Promise((resolve) => { setTimeout(resolve, 10); });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(resolved, false, "requesting force termination is not proof of process death");

  child.emit("exit", 137, "SIGKILL");
  await closing;
  assert.equal(resolved, true);
});

test("close rejects when force termination cannot establish an exit", async () => {
  const gateway = new HermesGateway({ closeGraceMs: 0 });
  const child = childDouble({ forceError: new Error("access denied") });
  gateway.child = child;

  await assert.rejects(gateway.close(), /Could not prove Hermes gateway termination/);
});
