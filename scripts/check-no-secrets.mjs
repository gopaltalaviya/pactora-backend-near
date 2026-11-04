#!/usr/bin/env node
/**
 * Refuse to commit secrets in tracked files.
 *
 * `.env.example` is TRACKED, and its whole job is to sit next to `.env` with
 * the same variable names — which makes pasting a real value into the wrong
 * one of the two an easy, quiet mistake. This is the check that makes it
 * loud instead.
 *
 * Runs in CI and is worth wiring to a pre-commit hook.
 */
import {execSync} from 'node:child_process';
import {readFileSync, existsSync} from 'node:fs';

const PATTERNS = [
  {name: '32-byte private key', re: /0x[0-9a-fA-F]{64}/},
  {name: 'Anthropic API key', re: /sk-ant-[A-Za-z0-9_-]{10,}/},
  {name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/},
  {name: 'PEM private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/},
  // The providers this project actually holds keys for, plus the host.
  {name: 'Google/Gemini API key', re: /AIza[0-9A-Za-z_-]{35}/},
  {name: 'Groq API key', re: /gsk_[A-Za-z0-9]{20,}/},
  {name: 'OpenAI API key', re: /sk-(?:proj-)?[A-Za-z0-9]{32,}/},
  {name: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{36,}/},
  // A connection string with a real password. The local docker default
  // (agentx:agentx@127.0.0.1) is documentation, not a secret.
  {
    name: 'database URL with a password',
    re: /postgres(?:ql)?:\/\/[^:\s/@]+:(?!agentx@)[^@\s]{4,}@(?!127\.0\.0\.1|localhost)[^\s/'"]+/,
  },
];

/**
 * BIP-39 mnemonics, checked per line instead of with one loose regex.
 *
 * The obvious pattern — "twelve or more short lowercase words" — matches
 * ordinary English. It fired on the sentence "bug in this project passed its
 * unit tests and was caught only against the real", which is fourteen
 * consecutive 3-to-8-letter words and not a secret.
 *
 * The false positive matters less than what it would have taught: a check
 * that cries wolf on prose in every markdown file is a check people learn to
 * pass with --no-verify, and the same hook is what guards the actual private
 * keys.
 *
 * So this asks what a mnemonic really looks like — exactly 12, 15, 18, 21 or
 * 24 lowercase words, space separated, alone on a line or alone inside a
 * quoted or assigned value. Prose carries punctuation, capitals and words
 * outside 3-8 letters, and a sentence almost never lands on exactly one of
 * those five lengths with nothing else on the line.
 */
const MNEMONIC_LENGTHS = new Set([12, 15, 18, 21, 24]);

function looksLikeMnemonic(text) {
  for (const raw of text.split(/\r?\n/)) {
    // Strip what would wrap a mnemonic in a config file: KEY=, quotes,
    // brackets and markdown backticks. What remains must be only the words.
    const line = raw
      // The key may be quoted (`"mnemonic":` in JSON) or bare (`MNEMONIC=`).
      .replace(/^\s*(?:["']?[A-Za-z_][A-Za-z0-9_]*["']?\s*[:=]\s*)?/, '')
      .replace(/^[`'"[]+|[`'",\]]+$/g, '')
      .trim();

    if (!/^[a-z]+(?: [a-z]+)*$/.test(line)) continue;

    const words = line.split(' ');
    if (!MNEMONIC_LENGTHS.has(words.length)) continue;
    if (words.some((w) => w.length < 3 || w.length > 8)) continue;

    return true;
  }
  return false;
}

// Addresses, tx hashes and Solidity constants are 20- or 32-byte hex too, so
// only scan files where a secret would actually be pasted.
const SCANNED = /(^|\/)(\.env\.example|\.env\.sample|.*\.env)$|\.(md|json|ya?ml)$/;

const tracked = execSync('git ls-files', {encoding: 'utf8'}).split('\n').filter(Boolean);
const problems = [];

for (const file of tracked) {
  if (!SCANNED.test(file)) continue;
  if (!existsSync(file)) continue;
  // deployments/*.json holds addresses, never keys — and PROGRESS-style docs
  // legitimately quote hashes.
  const text = readFileSync(file, 'utf8');

  // A keystore ciphertext is not a key, and lock files are noise.
  if (file.includes('lock')) continue;

  for (const {name, re} of PATTERNS) {
    if (re.test(text)) problems.push(`${file}: looks like a ${name}`);
  }
  if (looksLikeMnemonic(text)) problems.push(`${file}: looks like a BIP-39 mnemonic`);
}

if (problems.length) {
  console.error('\n✗ Secrets found in TRACKED files\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\n  Secrets belong in .env (gitignored), never .env.example.\n');
  process.exit(1);
}

console.log(`✓ No secrets in ${tracked.length} tracked files`);
