/**
 * `remember`'s stated answer for content it cannot take, on the surface a user
 * actually reaches.
 *
 * U21 approach step 4, in the plan's own words: "`remember` with a voice memo,
 * video, or unrecognized binary returns a typed error naming what is and is not
 * supported, rather than accepting and silently never indexing it. This happens
 * in week one, not year two."
 *
 * **Silent acceptance is the failure mode.** The tool's `statement` is a string,
 * so a client holding a voice memo has exactly two options today: send its
 * base64 as prose, which is stored and indexed as gibberish nobody can search
 * for, or ask. `media_type` is the asking, and the answer is a refusal that
 * names both sets — so the client learns "not this, ever" and "this, through a
 * different door" as different answers, rather than as one shrug.
 *
 * The refusal is deliberately not confined to the unsupported half. A PNG is
 * transcribable, and `remember` still cannot take it: acceptance means
 * preserving the raw payload under the tenant prefix (R16), and the request path
 * holds no object store. Answering "yes" and dropping the bytes would be the
 * silent acceptance this whole unit is designed against.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { SUPPORTED_MEDIA_TYPES } from '../../src/core/media/accept.ts';
import { TOOLS } from '../../src/mcp/tools/index.ts';
import { createMcpFixture, type McpFixture } from '../mcp/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

let fixture: McpFixture;

beforeAll(async () => {
  fixture = await createMcpFixture('mediaremember');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

function textOf(result: { readonly content: unknown; readonly error?: unknown }): string {
  return JSON.stringify({ content: result.content, error: result.error });
}

describe('the tool says it can be asked', () => {
  test('`remember` advertises `media_type`, so a client has a way to ask', () => {
    const remember = TOOLS.find((tool) => tool.name === 'remember');
    expect(remember?.params['media_type']).toBeDefined();
    expect(remember?.params['media_type']?.required).not.toBe(true);
  });
});

describe('a voice memo', () => {
  test(
    'is refused, and the refusal names the supported set',
    async () => {
      const result = await fixture.call('remember', {
        statement: 'A voice memo about the offsite.',
        media_type: 'audio/m4a',
      });

      const body = textOf(result);
      expect(body).toContain('audio/m4a');
      for (const supported of SUPPORTED_MEDIA_TYPES) expect(body).toContain(supported);
      // Refused as a parameter problem, not as an outage: retrying will not fix
      // it, and `unavailable` would tell the client to try again forever.
      expect(body).toContain('invalid_params');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'is not stored under the statement it arrived with',
    async () => {
      const canary = 'A voice memo whose prose must not become a memory.';
      await fixture.call('remember', { statement: canary, media_type: 'audio/m4a' });

      const rows = (await fixture.sql`
        SELECT count(*)::int AS n FROM fact WHERE statement = ${canary}
      `) as Array<{ n: number }>;
      expect(rows[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a screenshot', () => {
  test(
    'is refused too, but the answer names the door that is open',
    async () => {
      const result = await fixture.call('remember', {
        statement: 'A screenshot of the router page.',
        media_type: 'image/png',
      });

      const body = textOf(result);
      expect(body).toContain('image/png');
      // The distinction that makes this a policy rather than a wall.
      expect(body.toLowerCase()).toMatch(/connect|import/);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('an ordinary remember is untouched', () => {
  test(
    'a statement with no media declared is stored exactly as before',
    async () => {
      const result = await fixture.call('remember', {
        statement: 'The spare key is in the blue tin.',
      });
      expect(textOf(result)).toContain('fact:');
    },
    TEST_TIMEOUT_MS,
  );
});
