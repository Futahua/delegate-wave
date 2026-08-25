// The probe that decides whether work may be taken away from another process.
//
// Everything the wake outbox does about abandoned deliveries rests on this answering correctly, and
// its two dangerous answers are opposite: a false DEAD lets two processes write into one
// conversation, and a false ALIVE stalls a queue forever. The asymmetry is deliberate -- only a
// positive DEAD authorises anything, so every uncertainty must land on UNKNOWN rather than guess.
import assert from "node:assert/strict";
import test from "node:test";
import { ALIVE, DEAD, UNKNOWN, probeProcess, processStartedAt, selfIdentity } from "../src/session/liveness.js";

// A stand-in for the OS query, so the cases that matter can be stated rather than arranged.
const runner = (result) => async () => ({ exitCode: 0, stdout: "", stderr: "", ...result });

test("this process can identify itself in the terms another process will ask about it", async () => {
  const self = await selfIdentity();
  assert.equal(self.pid, process.pid);
  // Measured through the SAME query that will later check it. Deriving it from process.uptime()
  // would produce a number the probe could never reproduce, and every claim would be permanently
  // unreclaimable -- a stuck queue that looks exactly like a working one.
  assert.ok(self.startedAt, "the platform must be able to report its own process start time");
  assert.equal(await probeProcess(self.pid, self.startedAt), ALIVE);
});

test("a reused pid is dead, which is what a pid-only probe gets wrong", async () => {
  const self = await selfIdentity();
  // Same pid, a start time from the process that used to hold it. Something is alive at that
  // number; it is not the thing that claimed the wake.
  assert.equal(await probeProcess(self.pid, "a-different-start-time"), DEAD);
});

test("a pid nothing answers to is dead", async () => {
  assert.equal(await probeProcess(999_999, "whenever"), DEAD);
});

test("an unanswerable question is UNKNOWN, and UNKNOWN authorises nothing", async () => {
  // No recorded start time to compare against: the process exists, but nothing proves it is the
  // same one. Not DEAD -- taking its work on this evidence is exactly the race the outbox forbids.
  const self = await selfIdentity();
  assert.equal(await probeProcess(self.pid, null), UNKNOWN);
  assert.equal(await probeProcess(self.pid, ""), UNKNOWN);
  // A nonsensical pid cannot be investigated at all.
  assert.equal(await probeProcess(0, "x"), UNKNOWN);
  assert.equal(await probeProcess(-1, "x"), UNKNOWN);
  assert.equal(await probeProcess(1.5, "x"), UNKNOWN);
});

test("a query that fails reports nothing rather than inventing a start time", async () => {
  const options = { platform: "win32", run: runner({ exitCode: 1, stdout: "" }) };
  assert.equal(await processStartedAt(4242, options), null);
  // Output that is not a start time is also not a start time.
  assert.equal(await processStartedAt(4242, { platform: "win32", run: runner({ stdout: "no" }) }), null);
  // And a query that throws is a failed observation, never a death.
  const throwing = { platform: "win32", run: async () => { throw new Error("powershell is missing"); } };
  assert.equal(await processStartedAt(4242, throwing), null);
});

test("each platform is asked in its own terms", async () => {
  const asked = [];
  const record = async (command, args) => {
    asked.push([command, ...args].join(" "));
    return { exitCode: 0, stdout: "12345", stderr: "" };
  };
  assert.equal(await processStartedAt(77, { platform: "win32", run: record }), "12345");
  assert.match(asked[0], /powershell.*Get-Process -Id 77/);
  assert.equal(await processStartedAt(77, { platform: "darwin", run: record }), "12345");
  assert.match(asked[1], /^ps -o lstart= -p 77$/);
});
