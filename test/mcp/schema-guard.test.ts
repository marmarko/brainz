/**
 * The request path's schema gate — U3's refusal, on the path that has to issue
 * it.
 *
 * `control/migrate.ts` has had the typed refusals since U3: a tenant *behind*
 * the fleet is migrated and retried, a tenant *ahead* of it cannot be fixed by
 * this instance at all. What it did not have is a caller. `mcp/tenant-db.ts`
 * opened a tenant's database without ever reading a schema version, so the
 * promise "the request path refuses to serve a tenant whose schema it does not
 * understand" was exercised by one unit test and by nothing that serves traffic
 * — which is the shape this suite keeps finding: a guard that exists and never
 * runs.
 *
 * **Two things are asserted, and the second is the one that is easy to fake.**
 * That the refusal happens at all, and that it happens *before* the handler
 * queries tables it may not understand. The second is observable because a
 * rung-one tenant has `page` and `chunk` and no `entity` or `fact`: without the
 * gate the handler's own SQL fails and the surface answers `error`, which is a
 * bug reported as a bug. With it, the surface answers `unavailable` with the
 * remedy attached, and nothing was asked of the database at all.
 *
 * **And the third is the cache.** The version rides the connection entry the LRU
 * already holds, because reading it per request would put a round trip on the
 * warm p99 promise `entity` is measured against. A cached version that outlives
 * a migration is how a tenant keeps being refused by a fleet that could now
 * serve it, so the refusal path re-reads before it refuses, and the TTL bounds
 * the other direction.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { migrateTenantSchema } from '../../src/control/migrate.ts';
import { HEAD_SCHEMA_VERSION } from '../../src/schema/migrations.ts';
import { AGENT_ORIGIN, createMcpFixture, type McpFixture } from './fixture.ts';
import { deriveSigningKey, mintAccessToken, type GrantClaims } from '../../src/mcp/oauth.ts';
import { FIXTURE_FTS_LANGUAGE } from '../schema/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const PERSONAL = 'personal:mail';

/** A tenant left at rung one — every suspended tenant, after a deploy. */
let behind: McpFixture;
/** A tenant at head, used for the ahead case and for the cache's two directions. */
let current: McpFixture;

beforeAll(async () => {
  behind = await createMcpFixture('schemabehind', { schemaVersion: 1 });
  current = await createMcpFixture('schemacurrent');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await behind?.close();
  await current?.close();
});

/** A signed grant with explicit origins, so dispatch never reads the brain's own. */
function tokenWithOrigins(fixture: McpFixture, origins: readonly string[]): string {
  const claims: GrantClaims = {
    grantId: `g-${origins.join('-')}`,
    tenantId: fixture.tenantId,
    origins,
    writeOrigin: AGENT_ORIGIN,
    endpoint: 'mcp',
    clientId: 'client-schema-guard',
    issuedAt: fixture.now(),
    expiresAt: fixture.now() + 3_600_000,
  };
  return mintAccessToken(claims, deriveSigningKey(fixture.bearer));
}

describe('a tenant behind the fleet', () => {
  test(
    'is refused with the remedy, not with a generic unavailability',
    async () => {
      const result = await behind.call('entity', { name: 'Anyone At All' });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('unavailable');
      // The distinction the caller acts on: this one resolves itself.
      expect(result.error?.message).toMatch(/upgrad/i);
      expect(result.error?.suggestion).toMatch(/again/i);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'is refused before the handler queries a table this fleet may not understand',
    async () => {
      // An explicit-origin grant skips the brain-origins read, so the only thing
      // between dispatch and `entity`'s own SQL is the gate. Rung one has no
      // `entity` table: without the gate this is a failed query surfacing as
      // `error`, which is the shape U3 says must not happen.
      const result = await behind.call(
        'entity',
        { name: 'Anyone At All' },
        { authorization: `Bearer ${tokenWithOrigins(behind, [PERSONAL])}` },
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('unavailable');
      expect(result.error?.code).not.toBe('error');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'is served again on the very next call once something migrates it',
    async () => {
      // The cache's dangerous direction. The entry the LRU holds says rung one;
      // the sweep has just moved the tenant. A version that only expired with
      // the connection would keep refusing a servable tenant for the length of
      // the TTL, which turns a migration into an outage of its own.
      await migrateTenantSchema(behind.sql, { ftsLanguage: FIXTURE_FTS_LANGUAGE });

      const result = await behind.call('entity', { name: 'Anyone At All' });
      expect(result.ok).toBe(true);
      expect((result.content as { found: boolean }).found).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a tenant ahead of the fleet', () => {
  test(
    'is refused with a remedy this instance cannot perform',
    async () => {
      // Migrated past anything this release can be responsible for. Retrying
      // will not help and neither will migrating: this instance is the old one.
      await current.sql`
        INSERT INTO schema_migration (version, name)
        VALUES (${HEAD_SCHEMA_VERSION + 5}, 'from-a-later-release')
      `;
      // Past the TTL, so the accessor re-reads rather than serving the version
      // it banked on the first open.
      current.advance(10 * 60 * 1000);

      const result = await current.call('entity', { name: 'Anyone At All' });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('unavailable');
      expect(result.error?.message).toMatch(/this server understands|instance/i);

      await current.sql`DELETE FROM schema_migration WHERE version = ${HEAD_SCHEMA_VERSION + 5}`;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'costs no round trip while the entry is warm',
    async () => {
      // Warm the entry at a version this fleet serves.
      current.advance(10 * 60 * 1000);
      expect((await current.call('entity', { name: 'Anyone At All' })).ok).toBe(true);

      // Move the database underneath it. A gate that re-read per request would
      // notice — and would be charging every warm call a round trip to do it.
      await current.sql`
        INSERT INTO schema_migration (version, name)
        VALUES (${HEAD_SCHEMA_VERSION + 5}, 'from-a-later-release')
      `;
      expect((await current.call('entity', { name: 'Anyone At All' })).ok).toBe(true);

      // The TTL is what bounds the staleness, exactly as it bounds a revoked
      // secret: absolute from the resolve, not extended by use.
      current.advance(10 * 60 * 1000);
      const stale = await current.call('entity', { name: 'Anyone At All' });
      expect(stale.ok).toBe(false);
      expect(stale.error?.code).toBe('unavailable');

      await current.sql`DELETE FROM schema_migration WHERE version = ${HEAD_SCHEMA_VERSION + 5}`;
    },
    TEST_TIMEOUT_MS,
  );
});
