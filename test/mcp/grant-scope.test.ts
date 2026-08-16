/**
 * U18 §3 — the grant scope itself, tested as a function rather than through a
 * request.
 *
 * `test/mcp/context-grants.test.ts` proves the *property* (a work grant cannot
 * reach a personal row) end to end through a real database. This file proves the
 * *guards*, one at a time, so that each one can be mutated in isolation and be
 * seen to die for its own reason.
 *
 * That separation is the lesson this repo already paid for: three access
 * controls where only one was doing the work, because the mutations were never
 * applied in isolation. An integration suite kills a mutation somewhere; it does
 * not tell you which control was load-bearing.
 */

import { describe, expect, test } from 'bun:test';

import {
  agentOriginFor,
  classOf,
  classesOf,
  contextGrant,
  expandGrant,
  grantScopeViolations,
  isClassWildcard,
  isConcreteOrigin,
  resolveGrant,
} from '../../src/mcp/grant-scope.ts';

describe('the origin grammar', () => {
  test('a well-formed origin is class and source separated by one colon', () => {
    expect(isConcreteOrigin('personal:mail')).toBe(true);
    expect(isConcreteOrigin('work:calendar')).toBe(true);
    expect(isConcreteOrigin('personal:agent')).toBe(true);
  });

  test('the shapes that have no class are refused rather than guessed at', () => {
    // Each of these would produce *some* answer from a naive `split(':')[0]`,
    // and a fence deciding access on a guessed class is a fence deciding access
    // on a value nobody defined.
    for (const bad of ['personal', ':mail', 'personal:', 'a:b:c', 'Work:mail', '', 'work mail']) {
      expect(isConcreteOrigin(bad), bad).toBe(false);
      expect(classOf(bad), bad).toBeNull();
    }
  });

  test('a class wildcard is a class and a star, and nothing else is', () => {
    expect(isClassWildcard('work:*')).toBe(true);
    expect(isClassWildcard('personal:*')).toBe(true);
    expect(isClassWildcard('*')).toBe(false);
    expect(isClassWildcard('*:*')).toBe(false);
    expect(isClassWildcard('work:m*')).toBe(false);
  });

  test('the agent origin is derived from the class, not chosen', () => {
    expect(agentOriginFor('work')).toBe('work:agent');
    expect(agentOriginFor('personal')).toBe('personal:agent');
  });
});

describe('grantScopeViolations — the fail-open this module exists to close', () => {
  test('a narrowed grant with no origins is a violation, not the whole brain', () => {
    const findings = grantScopeViolations({ scope: 'narrowed', origins: [], writeOrigin: 'work:agent' });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(' ')).toContain('at least one origin');
  });

  test('a whole_brain grant carrying origins is a violation too', () => {
    // The other half of the same invariant. A list nobody reads is a narrowing
    // its author believed in, and the reader that ignores it hands over the
    // brain while the caller thinks they scoped it.
    const findings = grantScopeViolations({
      scope: 'whole_brain',
      origins: ['work:mail'],
      writeOrigin: 'personal:agent',
    });
    expect(findings.length).toBeGreaterThan(0);
  });

  test('a coherent narrowed grant is clean', () => {
    expect(
      grantScopeViolations({ scope: 'narrowed', origins: ['work:*'], writeOrigin: 'work:agent' }),
    ).toEqual([]);
    expect(
      grantScopeViolations({
        scope: 'narrowed',
        origins: ['work:mail', 'work:calendar'],
        writeOrigin: 'work:mail',
      }),
    ).toEqual([]);
  });

  test('a write origin outside the grant is a violation', () => {
    const findings = grantScopeViolations({
      scope: 'narrowed',
      origins: ['work:*'],
      writeOrigin: 'personal:agent',
    });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(' ')).toContain('outside this grant');
  });

  test('a write origin whose class merely shares a prefix with the grant is outside it', () => {
    // `work` is a prefix of `workplace`. R9's storage finding, one store over.
    const findings = grantScopeViolations({
      scope: 'narrowed',
      origins: ['work:*'],
      writeOrigin: 'workplace:agent',
    });
    expect(findings.length).toBeGreaterThan(0);
  });

  test('a malformed origin in the list is a violation', () => {
    expect(
      grantScopeViolations({ scope: 'narrowed', origins: ['work'], writeOrigin: 'work:agent' }).length,
    ).toBeGreaterThan(0);
  });

  test('an unknown scope value is refused rather than treated as one of the two', () => {
    const findings = grantScopeViolations({
      scope: 'everything' as never,
      origins: [],
      writeOrigin: 'personal:agent',
    });
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe('expandGrant', () => {
  const brain = ['personal:mail', 'personal:agent', 'work:mail', 'work:calendar', 'workplace:mail'];

  test('a class wildcard expands to every origin of that class', () => {
    expect(expandGrant(['work:*'], brain)).toEqual(['work:agent', 'work:calendar', 'work:mail']);
  });

  test('and never to a class that merely starts with the same letters', () => {
    // The single most important line in this file. `startsWith('work')` here
    // makes a work connector read `workplace:mail`, silently, holding a
    // credential the system considers correctly scoped.
    expect(expandGrant(['work:*'], brain)).not.toContain('workplace:mail');
    expect(expandGrant(['workplace:*'], brain)).not.toContain('work:mail');
  });

  test('the expansion has a non-empty floor even on a brain holding nothing of that class', () => {
    // Belt to the explicit `scope` marker's braces. `fence.ts` is fail-closed on
    // an empty grant, so an empty expansion would be *safe* today — but the
    // failure this repo actually had was a reader deciding an empty list meant
    // "everything", and a floor means no future reader is ever handed one.
    expect(expandGrant(['other:*'], [])).toEqual(['other:agent']);
    expect(expandGrant(['work:*'], []).length).toBeGreaterThan(0);
  });

  test('a concrete origin survives even when the brain holds no row at it', () => {
    // Otherwise a grant is silently re-scoped by an empty corpus, and a
    // connector that worked yesterday stops working after a purge.
    expect(expandGrant(['work:sms'], brain)).toEqual(['work:sms']);
  });

  test('a malformed entry contributes nothing rather than being passed through', () => {
    expect(expandGrant(['work', ':mail', 'work:*'], brain)).toEqual([
      'work:agent',
      'work:calendar',
      'work:mail',
    ]);
  });

  test('the result is sorted and de-duplicated, so two identical grants bind one parameter', () => {
    expect(expandGrant(['work:mail', 'work:*', 'work:mail'], brain)).toEqual([
      'work:agent',
      'work:calendar',
      'work:mail',
    ]);
  });
});

describe('resolveGrant — the one place a credential becomes a fence', () => {
  const brain = ['personal:mail', 'personal:agent', 'work:mail', 'workplace:mail'];
  const census = () => Promise.resolve(brain);

  test('a whole_brain grant reads every origin the brain holds, plus its write origin', async () => {
    const grant = await resolveGrant(
      { scope: 'whole_brain', origins: [], writeOrigin: 'personal:agent' },
      census,
    );
    expect(grant).toEqual(['personal:agent', 'personal:mail', 'work:mail', 'workplace:mail']);
  });

  test('a whole_brain grant on an empty brain still holds its own write origin', async () => {
    // R2a's activation loop: a brand-new tenant stores its first memory and
    // reads it back before any connector exists. A grant of `[]` here would
    // make the very first `remember`/`recall` pair fail.
    const grant = await resolveGrant(
      { scope: 'whole_brain', origins: [], writeOrigin: 'personal:agent' },
      () => Promise.resolve([]),
    );
    expect(grant).toEqual(['personal:agent']);
  });

  test('a narrowed grant resolves to its own class and nothing else', async () => {
    const grant = await resolveGrant(
      { scope: 'narrowed', origins: ['work:*'], writeOrigin: 'work:agent' },
      census,
    );
    expect(grant).toEqual(['work:agent', 'work:mail']);
  });

  test(
    'a narrowed grant that resolves to nothing reads NOTHING — it never falls back to the brain',
    async () => {
      // **The branch the request path can no longer reach, tested directly.**
      //
      // `grantScopeViolations` refuses `origins: []` at mint and at verify, so
      // no signed credential can produce this shape any more — which means a
      // mutation restoring the pre-U18 `length > 0 ? … : wholeBrain` line
      // SURVIVED the entire integration suite when this was a ternary inside
      // `dispatch.ts`. A guard nothing can provoke is a guard nobody can prove.
      // So the decision is a function, and this is the shape handed to it.
      const grant = await resolveGrant(
        { scope: 'narrowed', origins: [], writeOrigin: 'work:agent' },
        census,
      );
      expect(grant).toEqual([]);
      // Said the other way round, because the failure mode is the whole point:
      expect(grant).not.toContain('personal:mail');
    },
  );

  test('a narrowed grant of only concrete origins never pays for the census', async () => {
    // Not a micro-optimisation: making every request compute a four-way DISTINCT
    // over the corpus is how a fence acquires a reputation for being slow and
    // then acquires a bypass.
    let consulted = 0;
    const counting = () => {
      consulted += 1;
      return Promise.resolve(brain);
    };
    await resolveGrant({ scope: 'narrowed', origins: ['work:mail'], writeOrigin: 'work:mail' }, counting);
    expect(consulted).toBe(0);

    await resolveGrant({ scope: 'narrowed', origins: ['work:*'], writeOrigin: 'work:agent' }, counting);
    expect(consulted).toBe(1);
  });
});

describe('contextGrant — the product shape', () => {
  test('a context grant names its class wildcard and derives its own write origin', () => {
    expect(contextGrant('work')).toEqual({
      scope: 'narrowed',
      origins: ['work:*'],
      writeOrigin: 'work:agent',
    });
  });

  test('what it produces is always coherent — it cannot mint the fail-open shape', () => {
    for (const contextClass of ['work', 'personal', 'other']) {
      const scoped = contextGrant(contextClass);
      expect(scoped).not.toBeNull();
      expect(grantScopeViolations(scoped!)).toEqual([]);
    }
  });

  test('a class that is not a class produces nothing', () => {
    expect(contextGrant('Work')).toBeNull();
    expect(contextGrant('work:mail')).toBeNull();
    expect(contextGrant('')).toBeNull();
  });

  test('classesOf reports the classes a grant covers, for the surfaces that name them', () => {
    expect(classesOf(['work:*', 'work:mail', 'personal:agent'])).toEqual(['personal', 'work']);
    expect(classesOf(['nonsense'])).toEqual([]);
  });
});
