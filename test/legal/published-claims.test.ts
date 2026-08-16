/**
 * What the published documents claim, checked against what the code does.
 *
 * These two files are the artifact a data subject or a regulator quotes. They
 * are also the only artifact in the repo that nothing else verifies: prose is
 * not typechecked, and a sentence that outran the implementation stays true
 * -looking forever. Two failures are already on record for exactly that —
 * a terms-of-service clause asserting connector token revocation while
 * `ErasureReceipt.tokensRevoked` carries `'unverified'` verbatim from the
 * vendor, and a deletion window forwarded from one document to another that
 * states no window at all.
 *
 * **The trap this file is written against: asserting a document against
 * itself.** Grepping the terms for the sentence the terms contain proves
 * nothing. So every assertion below binds a document to evidence it does not
 * author — the constant the erasure path actually uses, the vendor register's
 * own status line, and the other published document.
 *
 * **The second trap is vacuity.** A regex over a file that moved reports a clean
 * sheet. Each document is asserted to be the document it claims to be, with the
 * section under test present, before anything is asserted about its content.
 */

import { describe, expect, test } from 'bun:test';

import { PITR_WINDOW_DAYS } from '../../src/core/lifecycle/erasure.ts';

const TERMS_PATH = 'docs/legal/terms-of-service.md';
const POLICY_PATH = 'docs/legal/privacy-policy.md';
const VENDOR_PATH = 'docs/vendor/2026-08-12-pipedream-compliance.md';

const terms = await Bun.file(TERMS_PATH).text();
const policy = await Bun.file(POLICY_PATH).text();
const vendor = await Bun.file(VENDOR_PATH).text();

/**
 * The clause both documents use for the connector leg.
 *
 * The privacy policy has always phrased it this way; the terms did not, and the
 * difference was the whole finding. One string, asserted in both, so the two
 * cannot drift apart again without this test naming which one moved.
 */
const CONNECTOR_CLAUSE = "the connector vendor's record of you";

describe('the documents under test are the documents', () => {
  test('each is present, and carries the section the claims below live in', () => {
    expect(terms).toContain('# Terms of service');
    expect(terms).toContain('## 9. Export and deletion');
    expect(policy).toContain('# Privacy policy');
    expect(policy).toContain('## Your requests');
    expect(vendor).toContain('# Vendor question — Pipedream Connect');
  });
});

describe('the deletion time bound is published, and it is the one the code uses', () => {
  test('the privacy policy states the window in days', () => {
    // Not "some number appears somewhere": the number the erasure receipt
    // carries, in the document the terms send a reader to.
    expect(policy).toContain(`${PITR_WINDOW_DAYS} days`);
  });

  test('the terms forward to a document that answers, rather than to one that does not', () => {
    // The terms are allowed to delegate the number — one place for it is better
    // than two that can disagree. They are not allowed to delegate it to a
    // document that never states it, which is what a dangling cross-reference
    // is: a reader sent from one artifact to another and told nothing.
    if (terms.includes('privacy policy states')) {
      expect(policy).toMatch(/\b\d+ days\b/);
    }
  });

  test('and the published number is derived from the code rather than copied beside it', () => {
    // A second, unlinked copy is how the first one goes stale. If the constant
    // moves, the document that quotes a different number fails here.
    const quoted = [...policy.matchAll(/\b(\d+) days\b/g)].map((match) => Number(match[1]));
    expect(quoted.length).toBeGreaterThan(0);
    for (const days of quoted) expect(days).toBe(PITR_WINDOW_DAYS);
  });
});

describe('no published document claims more about the connector than the vendor has answered', () => {
  test('the vendor question is still open, which is what makes the rest of this test binding', () => {
    // The arbiter. When a written answer arrives this line changes, and the
    // assertions below stop applying — deliberately, and visibly, in one place.
    expect(vendor).toContain('**Status:** draft, not yet sent');
    expect(vendor).toContain("tokensRevoked: 'unverified'");
  });

  test('both documents describe account deletion with the same clause', () => {
    expect(policy).toContain(CONNECTOR_CLAUSE);
    expect(terms).toContain(CONNECTOR_CLAUSE);
  });

  test('and neither asserts that the access grant itself was revoked', () => {
    // The sentence the vendor register says in as many words must not be
    // written: "promoting it to 'confirmed' without a written vendor answer
    // would put a false sentence in a privacy policy." Whether the vendor's
    // deletion revokes the grant at the mail provider is unanswered; a user who
    // deleted their account may still have a live token at a vendor, and no
    // published document may say otherwise while that is true.
    for (const [path, document] of [
      [TERMS_PATH, terms],
      [POLICY_PATH, policy],
    ] as const) {
      const deletion = document.slice(document.indexOf('deletion'));
      expect(`${path}: ${deletion}`).not.toMatch(/access token/i);
      expect(`${path}: ${deletion}`).not.toMatch(/revok/i);
    }
  });
});
