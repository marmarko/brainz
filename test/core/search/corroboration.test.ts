/**
 * R12a, attacked rather than described.
 *
 * **The requirement is a claim about an adversary, so the test is written as
 * one.** R12a says corroboration means an origin the external sender cannot also
 * write — "calendar AND mail attest this" is one attestation when the same
 * sender produced both, and a user restatement is what actually corroborates.
 * A test that asserts the happy path ("a user_out_of_band attestation
 * corroborates") passes against an implementation that also lets a stranger
 * corroborate his own claim, because it never asks.
 *
 * So every case below is a forgery attempt by **one external sender**, and the
 * assertion is that it fails. Two of them were live: an outsider whose content
 * lands as a file or a shared document is classified `user_curated`, which
 * carries no `external` attestation at all, and an assistant restating an
 * attacker's mail over `/mcp` produces `agent_mcp`, which R12a says clears
 * nothing. Both cleared the compiled-truth gate, because the gate asked "is this
 * externally sourced?" instead of "is this corroborated?" — and "externally
 * sourced" is a property the sender influences.
 */

import { describe, expect, test } from 'bun:test';

import { CHANNEL_BY_SOURCE_TYPE } from '../../../src/core/search/arms.ts';
import { corroborationOf } from '../../../src/core/search/boosts.ts';
import type { Attestation } from '../../../src/core/search/types.ts';

const external = (senderKey: string): Attestation => ({ channel: 'external', senderKey });

describe('a single external sender cannot manufacture corroboration', () => {
  test('two surfaces, one sender, one attestation', () => {
    // The mail and the calendar event auto-derived from it. The derived row
    // carries its root's sender, which is what makes the collapse observable.
    const verdict = corroborationOf([
      external('sender:attacker@example.test'),
      external('sender:attacker@example.test'),
    ]);
    expect(verdict.independentOrigins).toBe(1);
    expect(verdict.corroborated).toBe(false);
    expect(verdict.eligibleForCompiledTruth).toBe(false);
  });

  test('two different senders are still not corroboration', () => {
    // `From:` is free. A boost keyed on distinct external senders would be a
    // ranking primitive an emailer controls by sending twice.
    const verdict = corroborationOf([
      external('sender:attacker@example.test'),
      external('sender:also-attacker@example.test'),
    ]);
    expect(verdict.independentOrigins).toBe(2);
    expect(verdict.corroborated).toBe(false);
    expect(verdict.eligibleForCompiledTruth).toBe(false);
  });

  test('landing the claim as a file or a shared document does not clear the gate', () => {
    // The forgery: `source_type` is what decides the channel, and an outsider
    // who shares a drive document or sends an attachment picks it. The channel
    // that results — `user_curated` — carries no `external` attestation, so a
    // gate that asks "is anything here external?" answers no and admits the
    // claim with nobody having attested to it. The module's own note says a
    // shared drive file is writable by whoever shared it; the gate has to agree.
    for (const sourceType of ['file', 'document', 'note'] as const) {
      expect(CHANNEL_BY_SOURCE_TYPE[sourceType]).toBe('user_curated');
      const verdict = corroborationOf([{ channel: 'user_curated' }]);
      expect(verdict.corroborated).toBe(false);
      expect(verdict.eligibleForCompiledTruth).toBe(false);
    }
  });

  test('an assistant restating the attacker’s mail clears nothing', () => {
    // The assistant holding `remember` is the same assistant reading the
    // attacker's mail, so `agent_mcp` is a restatement of the claim by the party
    // the claim was aimed at.
    const verdict = corroborationOf([
      external('sender:attacker@example.test'),
      { channel: 'agent_mcp' },
    ]);
    expect(verdict.restated).toBe(true);
    expect(verdict.corroborated).toBe(false);
    expect(verdict.eligibleForCompiledTruth).toBe(false);
  });

  test('a restatement alone, with no source at all, clears nothing either', () => {
    const verdict = corroborationOf([{ channel: 'agent_mcp' }]);
    expect(verdict.corroborated).toBe(false);
    expect(verdict.eligibleForCompiledTruth).toBe(false);
  });

  test('a row with no attestations is refused, not admitted', () => {
    const verdict = corroborationOf([]);
    expect(verdict.independentOrigins).toBe(0);
    expect(verdict.corroborated).toBe(false);
    expect(verdict.eligibleForCompiledTruth).toBe(false);
  });
});

describe('what does corroborate', () => {
  test('the user says so out of band', () => {
    const verdict = corroborationOf([
      external('sender:attacker@example.test'),
      { channel: 'user_out_of_band' },
    ]);
    expect(verdict.corroborated).toBe(true);
    expect(verdict.eligibleForCompiledTruth).toBe(true);
  });

  test('the brain derived it from non-external inputs', () => {
    const verdict = corroborationOf([{ channel: 'internal' }]);
    expect(verdict.corroborated).toBe(true);
    expect(verdict.eligibleForCompiledTruth).toBe(true);
  });

  test('no source type can stand in for either of them', () => {
    // The table stays small on purpose: a bigger one would be a way to promote a
    // claim by choosing its source type.
    const channels = new Set(Object.values(CHANNEL_BY_SOURCE_TYPE));
    expect(channels.has('user_out_of_band')).toBe(false);
    expect(channels.has('internal')).toBe(false);
  });
});
