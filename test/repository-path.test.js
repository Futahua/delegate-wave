import assert from "node:assert/strict";
import test from "node:test";
import { repositoryPathIdentity } from "../src/repository-path.js";

test("Windows repository identity folds case, separators, trailing slashes and extended prefixes", () => {
  const expected = repositoryPathIdentity("D:\\Programs\\evTEMP\\demo", "win32");
  for (const candidate of ["d:\\programs\\EVTEMP\\DEMO", "D:/Programs/evTEMP/demo/",
    "\\\\?\\D:\\Programs\\evTEMP\\demo", "D:\\Programs\\evTEMP\\other\\..\\demo"]) {
    assert.equal(repositoryPathIdentity(candidate, "win32"), expected);
  }
  assert.equal(repositoryPathIdentity("\\\\?\\UNC\\SERVER\\SHARE\\Demo", "win32"),
    repositoryPathIdentity("\\\\server\\share\\demo", "win32"));
  assert.equal(repositoryPathIdentity("D:\\", "win32"), "d:\\");
});

test("POSIX repository identity preserves case and roots", () => {
  assert.notEqual(repositoryPathIdentity("/tmp/Demo", "linux"), repositoryPathIdentity("/tmp/demo", "linux"));
  assert.equal(repositoryPathIdentity("/tmp/demo/", "linux"), "/tmp/demo");
  assert.equal(repositoryPathIdentity("/", "linux"), "/");
});
