#!/usr/bin/env node
// Send a plain-text email via Resend, reusing the app's existing Resend key.
// Used by the weekly "geo-research-digest" scheduled task to email the digest
// to Lukas. Standalone (no imports from the app, no npm deps: Node's global
// fetch and fs are enough), so it runs fine from a scheduled Claude Code task.
//
// Reads RESEND_API_KEY and optional INSIGHT_FROM_EMAIL from the local, gitignored
// .env (or the process environment). Exits 2 (not 1) when the key is missing so
// the caller can treat "email skipped" differently from "send failed".
//
// Usage:
//   node scripts/mail-digest.mjs --to you@example.com --subject "..." --file body.txt
//   echo "body" | node scripts/mail-digest.mjs --to you@example.com --subject "..."
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnv() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out = {};
  try {
    const raw = readFileSync(join(root, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // No local .env; fall back to whatever is already in the environment.
  }
  return out;
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const env = { ...loadDotEnv(), ...process.env };
const apiKey = env.RESEND_API_KEY;
const from = env.INSIGHT_FROM_EMAIL || "GEO Rise Research <onboarding@resend.dev>";
const to = arg("--to");
const subject = arg("--subject") || "GEO research digest";
const file = arg("--file");

if (!apiKey) {
  console.error(
    "mail-digest: RESEND_API_KEY not found in .env or the environment. Email skipped."
  );
  process.exit(2);
}
if (!to) {
  console.error("mail-digest: --to <email> is required.");
  process.exit(2);
}

const text = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");

const res = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ from, to, subject, text }),
});

if (!res.ok) {
  const detail = await res.text().catch(() => "");
  console.error(`mail-digest: Resend returned ${res.status}. ${detail}`);
  process.exit(1);
}

console.log(`mail-digest: sent to ${to}`);
