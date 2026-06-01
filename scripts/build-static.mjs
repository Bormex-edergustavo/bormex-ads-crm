import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist");
const apiBase =
  process.env.BORMEX_API_BASE ||
  "https://tnajelbyzkrifukfgnxv.functions.supabase.co/bormex-crm";

const [html, css, js, privacy] = await Promise.all([
  readFile(join(root, "index.html"), "utf8"),
  readFile(join(root, "styles.css"), "utf8"),
  readFile(join(root, "app.js"), "utf8"),
  readFile(join(root, "privacy.html"), "utf8"),
]);

const configuredHtml = html.replace(
  /<meta name="bormex-api-base" content="[^"]*"\s*\/?>/,
  `<meta name="bormex-api-base" content="${apiBase}" />`,
);

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(join(outDir, "index.html"), configuredHtml),
  writeFile(join(outDir, "styles.css"), css),
  writeFile(join(outDir, "app.js"), js),
  writeFile(join(outDir, "privacy.html"), privacy),
]);

console.log(`Static frontend built in dist/ with API ${apiBase}`);
