/**
 * R10's register, and the ways this test could pass without meaning anything.
 *
 * **The named trap: a completeness check that compares the register against
 * itself.** Parse `docs/register.md`, assert it contains what
 * `src/register/components.ts` says, and the register is complete by
 * construction and can still be wrong in fact — which is the whole failure R10
 * exists against, since the point of naming shared components is that adding one
 * becomes visible *before* it is paid for. So every assertion below runs against
 * evidence the register does not author: hostnames scanned out of `src/`,
 * providers reduced out of the shipped routing profiles, and bindings read out
 * of `wrangler.toml`.
 *
 * **The second trap is vacuity.** A scanner that finds nothing reports a clean
 * sheet, and a clean sheet is what a working register looks like. So the
 * evidence sets are asserted non-empty and asserted to contain specific things
 * that are really there, before anything is asserted about gaps.
 *
 * **The third is direction.** Only checking "the code names something the
 * register does not" lets the register accumulate vendors that were removed —
 * a blast-radius list that overstates itself is one nobody has read recently.
 * Both directions are checked, and both are red.
 */

import { describe, expect, test } from 'bun:test';

import { NOT_A_DESTINATION, SHARED_COMPONENTS } from '../../src/register/components.ts';
import {
  bindingsDeclared,
  collectEvidence,
  findRegisterGaps,
  hostsNamedIn,
  providersReachable,
  sourceFilesUnder,
  type RegisterEvidence,
} from '../../src/register/completeness.ts';
import {
  REGISTER_DOC_PATH,
  renderRegister,
  spliceRegister,
} from '../../src/register/render.ts';

const EVIDENCE = collectEvidence();

describe('the evidence is real before anything is concluded from it', () => {
  test('the source sweep finds files, and the ones a reader would expect', () => {
    const files = sourceFilesUnder('src');
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('src/ai/gateway.ts');
    expect(files).toContain('src/mcp/dispatch.ts');
  });

  test('the host scan finds the hosts that are actually in the tree', () => {
    // Named explicitly rather than counted: a count passes while the regex
    // matches something else entirely.
    expect([...EVIDENCE.hosts.keys()]).toContain('api.openai.com');
    expect([...EVIDENCE.hosts.keys()]).toContain('api.pipedream.com');
    expect([...EVIDENCE.hosts.keys()]).toContain('gateway.ai.cloudflare.com');
    expect(EVIDENCE.hosts.get('api.openai.com')).toContain('src/ai/gateway.ts');
  });

  test('the host scan ignores loopback rather than registering every test DSN', () => {
    expect([...EVIDENCE.hosts.keys()]).not.toContain('localhost');
  });

  test('the provider reduction reaches every shipped profile', () => {
    expect(providersReachable()).toEqual(['cloudflare', 'google', 'openai', 'self-host']);
  });

  test('the binding scan reads the real deployment manifest', () => {
    expect(EVIDENCE.bindings).toContain('MCP_FLEET');
    expect(EVIDENCE.bindings).toContain('WORKER_FLEET');
  });

  test('the binding scanner can parse a manifest it is given', () => {
    expect(
      bindingsDeclared('[[durable_objects.bindings]]\nname = "A_BINDING"\nclass_name = "AClass"\n'),
    ).toEqual(['AClass', 'A_BINDING']);
  });
});

describe('the register accounts for everything the code names', () => {
  test('no gaps, in either direction', () => {
    expect(findRegisterGaps()).toEqual([]);
  });

  test('every entry carries a blast radius and a rotation owner that say something', () => {
    for (const entry of SHARED_COMPONENTS) {
      // R10 asks for both by name. A one-word blast radius is a field filled in
      // rather than a question answered, so the bar is a sentence.
      expect({ id: entry.id, radius: entry.blast_radius.length > 80 }).toEqual({
        id: entry.id,
        radius: true,
      });
      expect({ id: entry.id, owner: entry.rotation_owner.length > 0 }).toEqual({
        id: entry.id,
        owner: true,
      });
      expect({ id: entry.id, rotation: entry.rotation.length > 40 }).toEqual({
        id: entry.id,
        rotation: true,
      });
    }
  });

  test('ids are unique, so two entries cannot claim to be one component', () => {
    const ids = SHARED_COMPONENTS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('the signing key’s entry records custody, rotation and revocation', () => {
    // R10: naming the blast radius is not containing it. The entry is the place
    // the containment is written down, so it is asserted rather than assumed.
    const key = SHARED_COMPONENTS.find((entry) => entry.id === 'attestation-signing-key');
    expect(key).toBeDefined();
    expect(key?.rotation).toContain('CUSTODY');
    expect(key?.rotation).toContain('ROTATION');
    expect(key?.rotation).toContain('REVOCATION');
    // And the honesty about what does not exist yet.
    expect(key?.rotation).toContain('no real key exists');
    expect(key?.blast_radius).toContain('any');
  });

  test('exactly two model-side processors receive content, per KTD13', () => {
    // The claim that makes a third provider a subprocessor change rather than a
    // config edit. If this number moves, the register moved with it — which is
    // the sequence R10 asks for.
    const contentProviders = SHARED_COMPONENTS.filter(
      (entry) => entry.kind === 'model-provider' && entry.transmits_user_content,
    ).map((entry) => entry.id);
    expect(contentProviders.sort()).toEqual(['cloudflare-models', 'google', 'openai']);
    // `cloudflare-models` is open weights on Cloudflare's own plane, so the
    // count of external labs holding user content is two, not three.
    const externalLabs = contentProviders.filter((id) => !id.startsWith('cloudflare'));
    expect(externalLabs.length).toBe(2);
  });
});

describe('the check goes red for a component nobody named', () => {
  const withExtra = (extra: Partial<RegisterEvidence>): RegisterEvidence => ({
    hosts: extra.hosts ?? EVIDENCE.hosts,
    providers: extra.providers ?? EVIDENCE.providers,
    bindings: extra.bindings ?? EVIDENCE.bindings,
  });

  test('a new vendor hostname is a finding', () => {
    const hosts = new Map(EVIDENCE.hosts);
    hosts.set('api.some-new-vendor.example', ['src/ingest/new-thing.ts']);
    const findings = findRegisterGaps(SHARED_COMPONENTS, withExtra({ hosts }), NOT_A_DESTINATION);
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain('api.some-new-vendor.example');
    expect(findings[0]).toContain('src/ingest/new-thing.ts');
  });

  test('a fourth routing provider is a finding', () => {
    const findings = findRegisterGaps(
      SHARED_COMPONENTS,
      withExtra({ providers: [...EVIDENCE.providers, 'anthropic'] }),
      NOT_A_DESTINATION,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain('anthropic');
    expect(findings[0]).toContain('subprocessor');
  });

  test('a new deployment binding is a finding', () => {
    const findings = findRegisterGaps(
      SHARED_COMPONENTS,
      withExtra({ bindings: [...EVIDENCE.bindings, 'RAW_PAYLOADS'] }),
      NOT_A_DESTINATION,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain('RAW_PAYLOADS');
  });

  test('an entry claiming a host the code no longer names is a finding', () => {
    const findings = findRegisterGaps(
      [
        ...SHARED_COMPONENTS,
        {
          id: 'departed-vendor',
          name: 'A vendor that was removed',
          kind: 'vendor',
          shared_by: 'all_tenants',
          transmits_user_content: true,
          blast_radius: 'x'.repeat(100),
          rotation_owner: 'nobody',
          rotation: 'y'.repeat(60),
          evidence: { hosts: ['api.departed.example'] },
        },
      ],
      EVIDENCE,
      NOT_A_DESTINATION,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain('overstates the blast radius');
  });

  test('an excuse for a host nobody names any more is a finding', () => {
    const findings = findRegisterGaps(SHARED_COMPONENTS, EVIDENCE, [
      ...NOT_A_DESTINATION,
      { host: 'gone.example', reason: 'it used to be in a comment' },
    ]);
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain('gone.example');
  });

  test('an empty register is many findings, not zero', () => {
    // The degenerate case, asserted because it is the shape a broken checker
    // takes: a filter that matches nothing reports a clean sheet.
    expect(findRegisterGaps([], EVIDENCE, []).length).toBeGreaterThan(10);
  });
});

describe('the published document is the register', () => {
  test('docs/register.md is fresh', async () => {
    const committed = await Bun.file(REGISTER_DOC_PATH).text();
    expect(spliceRegister(committed, renderRegister())).toBe(committed);
  });

  test('the machine block in the published document parses, and is the register', async () => {
    // R10 asks that an outsider audit the blast radius WITHOUT reading the
    // source. A machine pointed at `src/register/components.ts` is a machine
    // reading the source, so the document carries the data itself.
    const committed = await Bun.file(REGISTER_DOC_PATH).text();
    const block = /```json\n([\s\S]*?)```/.exec(committed)?.[1];
    expect(block).toBeDefined();

    const parsed = JSON.parse(block ?? '{}') as {
      components: typeof SHARED_COMPONENTS;
      not_a_destination: typeof NOT_A_DESTINATION;
    };
    expect(parsed.components).toEqual(SHARED_COMPONENTS as never);
    expect(parsed.not_a_destination).toEqual(NOT_A_DESTINATION as never);
  });

  test('the rendered document names every component and its rotation owner', () => {
    const rendered = renderRegister();
    for (const entry of SHARED_COMPONENTS) {
      expect(rendered).toContain(entry.id);
      expect(rendered).toContain(entry.rotation_owner);
    }
  });

  test('splicing refuses a document with no markers rather than appending', () => {
    expect(() => spliceRegister('# a document with no markers', 'anything')).toThrow(
      /missing the generated-region markers/,
    );
  });

  test('the host scanner is the one the document describes', () => {
    // The document tells a reader the sweep is a literal match over `src/`.
    // If that stopped being true the instructions would be wrong, and the
    // instructions are what an outsider audits with.
    const hosts = hostsNamedIn(['src/ai/gateway.ts']);
    expect([...hosts.keys()].sort()).toContain('api.openai.com');
  });
});
