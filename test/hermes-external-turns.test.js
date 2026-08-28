import test from "node:test";
import assert from "node:assert/strict";

import { replaceLoneSurrogates } from "../src/session/hermes-external-turns.js";

test("external-turn framing replaces lone surrogates but preserves valid pairs", () => {
  const smile = "\uD83D\uDE03";
  assert.equal(
    replaceLoneSurrogates(`before\uDC9Dmiddle${smile}after\uD800`),
    `before\uFFFDmiddle${smile}after\uFFFD`,
  );
});
