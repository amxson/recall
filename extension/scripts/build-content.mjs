import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, "..");

// Bundle as a self-contained classic script whose final expression returns PageExtractPayload
// so chrome.scripting.executeScript({ files: ["content_extract.js"] }) captures the return value.
await build({
  entryPoints: [resolve(extDir, "src", "content", "extract.ts")],
  outfile: resolve(extDir, "dist", "content_extract.js"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: true,
  // Strip any module export wrapper; esbuild in raw script mode with no exports evaluates cleanly
  // Using iife with globalName would swallow the return value, so emit top-level statements instead.
  platform: "browser",
});

console.log("Bundled content_extract.js -> dist/content_extract.js");
