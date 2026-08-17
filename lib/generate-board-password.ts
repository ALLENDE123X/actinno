/**
 * ACT-004 — per-(candidate, job board) unique password generator.
 *
 * A fresh crypto-random password per board, never reused, so a breach on one
 * ATS doesn't expose credentials on the others. Generating N unique passwords
 * costs the same as generating one shared password, so there is no reason to
 * share.
 *
 * This module is pure — it only produces a string. Persisting the result to
 * `job_applications.board_password` happens in ACT-005 (Playwright account
 * creation).
 *
 * TODO(before real / non-founder users): `job_applications.board_password` is
 * stored as plaintext. That is acceptable only while the table is locked to
 * service_role via RLS and the sole user is the founder. Before onboarding real
 * users, encrypt at rest (pgsodium / Supabase Vault, or app-level envelope
 * encryption with a KMS-held key) and decrypt only inside the Playwright step
 * that actually types the password. The write site added in ACT-005 is the
 * place to hook that in.
 */

import { randomInt } from "node:crypto";

// Ambiguous glyphs (I/l/1, O/0) are omitted so a password stays transcribable
// if it ever has to be read off a screen and typed by hand.
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 24 — no I, O
const LOWER = "abcdefghijkmnpqrstuvwxyz"; // 24 — no l, o
const DIGITS = "23456789"; //                 8 — no 0, 1

// Deliberately conservative symbol set. These are the punctuation characters
// ATS password validators most consistently accept; `&`, `=`, `+`, `<`, `>`
// and quotes are excluded because they are the ones that tend to trip
// server-side validation or naive encoding on older ATS form handlers. Not a
// response to a specific observed failure — just the cheap default. Revisit if
// a real board rejects one of these.
const SYMBOLS = "!@#$%*-_"; //                8

// 24 + 24 + 8 + 8 = 64, i.e. exactly 6 bits of entropy per character.
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

/** Uniform pick from `charset`. `randomInt` rejection-samples, so no modulo bias. */
function randomChar(charset: string): string {
  return charset.charAt(randomInt(charset.length));
}

/**
 * Generate a unique, cryptographically random password for one
 * (candidate, job board) pair.
 *
 * Guarantees at least one uppercase, lowercase, digit and symbol, which covers
 * the strictest complexity rule in common use across ATS platforms (most
 * require 8+ with upper + lower + digit; some also require a symbol).
 *
 * Default length is 16: comfortably above every minimum, and below the 20-char
 * maximum that some older ATS signup forms silently enforce.
 *
 * At the default length this is 96 bits of entropy (64 charset, 6 bits/char),
 * minus a fraction of a bit for the guaranteed-class seeding.
 *
 * @param length Password length. Must be an integer >= 8.
 */
export function generateBoardPassword(length = 16): string {
  if (!Number.isInteger(length) || length < 8) {
    throw new Error(
      `generateBoardPassword: length must be an integer >= 8, got ${length}`,
    );
  }

  // Seed one character from each required class, then fill the rest from the
  // full charset.
  const chars = [
    randomChar(UPPER),
    randomChar(LOWER),
    randomChar(DIGITS),
    randomChar(SYMBOLS),
    ...Array.from({ length: length - 4 }, () => randomChar(ALL)),
  ];

  // Fisher-Yates, so the four seeded characters aren't always in positions 0-3.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); // inclusive of i — a character may stay put
    const tmp = chars[i] as string;
    chars[i] = chars[j] as string;
    chars[j] = tmp;
  }

  return chars.join("");
}
