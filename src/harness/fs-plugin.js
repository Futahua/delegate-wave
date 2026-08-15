// Cordis plugin entry: this attempt's fenced `ctx.fs` provider.
//
// Loaded by path from the per-attempt profile patch, replacing the `fs-local` entry. Harness's
// loader instantiates a plugin module's default export directly as the service class -- exactly as
// `@deepseek-ai/dsh-fs-local` does -- so this module's default export must BE the class, not a
// wrapper that registers one. A wrapper never provides the `fs` service, and the boot fails with
// `tool-fs: pending (waiting for service: fs)`.
//
// The Harness base classes cannot be resolved relative to this file: dsh is installed beside the
// managed data root, not as a dependency of this repository, so this module's own resolution paths
// do not reach it. The backend passes the installation location in
// `DELEGATE_WAVE_HARNESS_HOME`, and resolution is anchored there.
import { createRequire } from "node:module";
import { createFencedFileSystemClassSync } from "./fenced-fs.js";

const home = process.env.DELEGATE_WAVE_HARNESS_HOME;
if (!home) {
  throw new Error("DELEGATE_WAVE_HARNESS_HOME is not set; the fenced filesystem cannot resolve Harness");
}

const FencedFileSystem = createFencedFileSystemClassSync({
  require: createRequire(`${home.replace(/\\/g, "/")}/package.json`),
});

export { FencedFileSystem, FencedFileSystem as default };
