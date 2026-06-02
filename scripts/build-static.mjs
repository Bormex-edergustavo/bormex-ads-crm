import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "dist");
const docsDir = join(root, "docs");
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

async function writeStaticFiles(targetDir) {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await Promise.all([
    writeFile(join(targetDir, "index.html"), configuredHtml),
    writeFile(join(targetDir, "styles.css"), css),
    writeFile(join(targetDir, "app.js"), js),
    writeFile(join(targetDir, "privacy.html"), privacy),
  ]);
}

await Promise.all([writeStaticFiles(outDir), writeStaticFiles(docsDir)]);

console.log(`Static frontend built in dist/ and docs/ with API ${apiBase}`);
