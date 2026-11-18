/**
 * Checks `vercel.json` before a build.
 *
 * Always: the security headers are present and both Content Security Policies
 * (production host, every other host) keep the required directives and never
 * allow inline or eval script, wildcards or other relaxations.
 *
 * On Vercel (`VERCEL_ENV` is set) it also fails the build while any
 * `__PLACEHOLDER__` remains, and when the policy for this deployment does not
 * allow the API and Logto origins the build was configured with. A mismatch
 * would otherwise only show up as a broken sign-in or blocked API calls.
 *
 * Usage: node scripts/check-deploy-config.mjs [path/to/vercel.json]
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'"],
  "object-src": ["'none'"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
};
const FORBIDDEN_SOURCES = ["'unsafe-inline'", "'unsafe-eval'", "*", "http:", "https:", "blob:"];
const PLACEHOLDER = /__[A-Z_]+__/;

/**
 * @param {string} value
 * @returns {Record<string, string[]>}
 */
export function parseCsp(value) {
  /** @type {Record<string, string[]>} */
  const directives = {};
  for (const part of value.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives[name] = sources;
  }
  return directives;
}

function headerValue(rule, key) {
  return rule.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
}

function origin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Returns a list of problems; empty when the configuration is acceptable. */
export function checkVercelConfig(config, env = {}) {
  const problems = [];
  const rules = config.headers ?? [];

  const all = rules.find((r) => r.source === "/(.*)" && !r.has && !r.missing);
  if (!all) problems.push("missing the header rule for every path");
  else {
    if (!headerValue(all, "Strict-Transport-Security")?.includes("max-age=")) problems.push("missing HSTS");
    if (headerValue(all, "Referrer-Policy") !== "strict-origin-when-cross-origin") problems.push("missing Referrer-Policy");
    if (headerValue(all, "X-Content-Type-Options") !== "nosniff") problems.push("missing X-Content-Type-Options");
  }

  const production = rules.find((r) => r.has?.some((c) => c.type === "host"));
  const others = rules.find((r) => r.missing?.some((c) => c.type === "host"));
  const variants = [
    ["production", production],
    ["preview", others],
  ];
  for (const [name, rule] of variants) {
    const csp = rule && headerValue(rule, "Content-Security-Policy");
    if (!csp) {
      problems.push(`missing the ${name} Content-Security-Policy`);
      continue;
    }
    const d = parseCsp(csp);
    for (const [directive, sources] of Object.entries(REQUIRED)) {
      const actual = d[directive] ?? [];
      if (actual.length !== sources.length || sources.some((s) => !actual.includes(s))) {
        problems.push(`${name} CSP: ${directive} must be exactly ${sources.join(" ")}`);
      }
    }
    for (const directive of ["connect-src", "form-action"]) {
      if (!d[directive]?.includes("'self'")) problems.push(`${name} CSP: ${directive} must include 'self'`);
    }
    for (const sources of Object.values(d)) {
      for (const s of sources) if (FORBIDDEN_SOURCES.includes(s)) problems.push(`${name} CSP: forbidden source ${s}`);
    }
  }

  if (production && others) {
    const prodHost = production.has.find((c) => c.type === "host").value;
    const otherHost = others.missing.find((c) => c.type === "host").value;
    if (prodHost !== otherHost) problems.push("the production and preview host conditions must name the same host");
  }

  if (env.VERCEL_ENV) {
    const text = JSON.stringify(config);
    if (PLACEHOLDER.test(text)) problems.push("vercel.json still contains __PLACEHOLDER__ values");
    const rule = env.VERCEL_ENV === "production" ? production : others;
    const host = production?.has?.find((c) => c.type === "host")?.value;
    if (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL && host !== env.VERCEL_PROJECT_PRODUCTION_URL) {
      problems.push("the production host condition does not match VERCEL_PROJECT_PRODUCTION_URL");
    }
    const csp = rule && parseCsp(headerValue(rule, "Content-Security-Policy") ?? "");
    const api = origin(env.VITE_API_BASE);
    const logto = origin(env.VITE_LOGTO_ENDPOINT);
    if (!api || !csp?.["connect-src"]?.includes(api)) problems.push("CSP connect-src does not allow VITE_API_BASE");
    if (!logto || !csp?.["connect-src"]?.includes(logto)) problems.push("CSP connect-src does not allow VITE_LOGTO_ENDPOINT");
    if (!logto || !csp?.["form-action"]?.includes(logto)) problems.push("CSP form-action does not allow VITE_LOGTO_ENDPOINT");
  }

  return problems;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const path = process.argv[2] ?? new URL("../../vercel.json", import.meta.url);
  const problems = checkVercelConfig(JSON.parse(readFileSync(path, "utf8")), process.env);
  if (problems.length > 0) {
    for (const p of problems) console.error(`vercel.json: ${p}`);
    process.exit(1);
  }
  console.log("vercel.json check passed");
}
