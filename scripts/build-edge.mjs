import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fnDir = join(root, "supabase", "functions", "bormex-crm");

const [html, css, js] = await Promise.all([
  readFile(join(root, "index.html"), "utf8"),
  readFile(join(root, "styles.css"), "utf8"),
  readFile(join(root, "app.js"), "utf8"),
]);

const bundled = html
  .replace(/<link rel="stylesheet" href="styles\.css"\s*\/?>/, `<style>\n${css}\n</style>`)
  .replace(/<script src="app\.js"><\/script>/, `<script>\n${js}\n</script>`);

await mkdir(fnDir, { recursive: true });
await writeFile(join(fnDir, "index.static.html"), bundled);
await writeFile(
  join(fnDir, "static-html.ts"),
  `export const STATIC_HTML = ${JSON.stringify(bundled)};\n`,
);
console.log("Edge frontend bundled into supabase/functions/bormex-crm/static-html.ts");
