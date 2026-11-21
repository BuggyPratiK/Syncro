/**
 * Fails when the production bundle contains anything that looks like a secret.
 * Every file in the build output is public, so none of these may appear:
 * - PEM key material (`-----BEGIN`);
 * - a Discord webhook URL prefix (a full URL is a bearer credential);
 * - a GitHub token prefix (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`).
 *
 * Usage: node scripts/check-bundle.mjs <build-dir>
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const FORBIDDEN = [
  { name: "PEM block", pattern: /-----BEGIN/ },
  { name: "Discord webhook URL", pattern: /discord\.com\/api\/webhooks\// },
  { name: "Discord webhook URL (legacy host)", pattern: /discordapp\.com\/api\/webhooks\// },
  { name: "GitHub token prefix", pattern: /gh[pousr]_/ },
];

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

/** Returns one finding per file and pattern; never prints the matched text. */
export function scan(dir) {
  const findings = [];
  for (const path of files(dir)) {
    const text = readFileSync(path).toString("latin1");
    for (const { name, pattern } of FORBIDDEN) {
      if (pattern.test(text)) findings.push({ file: relative(dir, path), name });
    }
  }
  return findings;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node scripts/check-bundle.mjs <build-dir>");
    process.exit(2);
  }
  const findings = scan(dir);
  if (findings.length > 0) {
    for (const f of findings) console.error(`Forbidden content (${f.name}) in ${f.file}`);
    process.exit(1);
  }
  console.log(`Bundle check passed: no forbidden content in ${dir}`);
}
