#!/usr/bin/env node
// Secret scan: keeps keys, tokens, credentials and valuable personal data (payment cards,
// account sessions) out of git. No dependencies, so it runs in the pre-commit hook on any clone.
//
//   node scripts/secret-scan.mjs            scan the staged changes (what the pre-commit hook runs)
//   node scripts/secret-scan.mjs --tree     scan every tracked file in the working tree
//
// CI runs gitleaks over the full history as the second layer (.github/workflows/secret-scan.yml), and
// GitHub push protection is the third. A finding that is a deliberate fake (a fixture) is allowed
// by putting `secret-scan: allow` on the same line, or by adding the exact value to ALLOW_VALUES.
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });

// Files that must never be committed, whatever they contain.
const BLOCKED_PATHS = [
  [/(^|\/)\.env(\.(?!example$|sample$|template$)[^/]+)?$/, "dotenv file"],
  [/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i, "key or keystore file"],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, "SSH key"],
  [/(^|\/)(\.netrc|\.pgpass|\.git-credentials|credentials(\.json)?|secrets?\.(json|ya?ml|toml))$/i, "credentials file"],
  [/(^|\/)\.claude\/settings\.local\.json$/, "local Claude settings"],
  [/(^|\/)launcher_(accounts|msa_credentials)[^/]*\.json$/i, "Minecraft launcher accounts (session tokens)"],
  [/(^|\/)autosketch-bridge\.toml$/, "bridge pairing file (live token)"],
  [/(^|\/)\.autosketch\/run\//, "MCP port file (bearer token)"],
];

const RULES = [
  ["private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI API key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|\bsk-proj-[A-Za-z0-9_-]{40,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Stripe key", /\b[rs]k_live_[A-Za-z0-9]{20,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b|_authToken\s*=\s*[^\s$]{10,}/],
  ["CurseForge/Modrinth token", /\bmrp_[A-Za-z0-9]{30,}|\$2a\$10\$[A-Za-z0-9./]{53}/],
  ["Discord token or webhook", /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}|\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}/],
  ["Microsoft account token", /\bM\.C\d{3}_[A-Za-z0-9!*$._-]{40,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["credentials in URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'<>]+:[^\s@/"'<>]{3,}@[^\s/"'<>]+/i],
  [
    "hardcoded secret",
    /\b(?:api[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|password|passwd|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer)["']?\s*[:=]\s*["']([A-Za-z0-9+/_.=-]{16,})["']/i,
  ],
];

// Fixture values that look like secrets on purpose.
const ALLOW_VALUES = new Set([
  "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // sha256("test"), bridge test token
]);
const ALLOW_MARK = "secret-scan: allow";
const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{[^}]*\}|changeme|example|placeholder|redacted|your[_-].*|test[_-].*|dummy.*|fake.*|bad_token)$/i;

// Payment card numbers: 13-19 digits, optionally grouped, with a valid Luhn checksum and a known
// issuer prefix. Test numbers from the card networks' docs still need `secret-scan: allow`.
const CARD = /\b(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))(?:[ -]?\d{4}){2}[ -]?\d{1,7}\b/g;
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

function scanLine(line) {
  if (line.includes(ALLOW_MARK)) return [];
  const hits = [];
  for (const [name, re] of RULES) {
    const m = line.match(re);
    if (!m) continue;
    const value = m[1] ?? m[0];
    if (ALLOW_VALUES.has(value) || PLACEHOLDER.test(value)) continue;
    hits.push([name, value]);
  }
  for (const m of line.matchAll(CARD)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) hits.push(["payment card number", m[0]]);
  }
  return hits;
}

const mask = (v) => (v.length <= 8 ? "****" : `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`);

const findings = [];
function checkPath(path) {
  for (const [re, what] of BLOCKED_PATHS) if (re.test(path)) findings.push(`${path}: ${what} must not be committed`);
}

if (process.argv.includes("--tree")) {
  for (const path of git("ls-files", "-z").split("\0").filter(Boolean)) {
    checkPath(path);
    let text;
    try {
      text = git("show", `:${path}`);
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // binary
    text.split("\n").forEach((line, i) => {
      for (const [name, v] of scanLine(line)) findings.push(`${path}:${i + 1}: ${name} ${mask(v)}`);
    });
  }
} else {
  for (const path of git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").split("\0").filter(Boolean)) checkPath(path);
  let file = "";
  let lineNo = 0;
  for (const line of git("diff", "--cached", "-U0", "--no-color", "--diff-filter=ACMR", "--no-ext-diff").split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(6);
    else if (line.startsWith("@@")) lineNo = Number(/\+(\d+)/.exec(line)?.[1] ?? 0) - 1;
    else if (line.startsWith("+")) {
      lineNo++;
      for (const [name, v] of scanLine(line.slice(1))) findings.push(`${file}:${lineNo}: ${name} ${mask(v)}`);
    }
  }
}

if (findings.length) {
  console.error("secret-scan: possible secrets or personal data found:\n");
  for (const f of findings) console.error(`  ${f}`);
  console.error(
    `\nRemove them (use an environment variable or a gitignored file instead). If a finding is a ` +
      `deliberate fake, add "${ALLOW_MARK}" on that line. Bypass once with git commit --no-verify only ` +
      `if you are sure: CI (gitleaks) and GitHub push protection check again.`,
  );
  process.exit(1);
}
