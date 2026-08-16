/**
 * `bun run test:roundtrip` — R18's **knowledge**-parity leg.
 *
 * The Verification Contract declares two round-trip gates and they are not two
 * strengths of the same check; they answer different questions:
 *
 *   | leg | command | where | what it proves |
 *   |---|---|---|---|
 *   | file parity | `bun test` | blocking, every push | export → import → export is a fixed point, byte for byte |
 *   | knowledge parity | **this** | scheduled, secret-gated | the re-imported brain still *knows* what the original knew |
 *
 * **Why the second exists.** R18 says model-derived artifacts — entity cards,
 * salience, commitments — are re-derived on import at re-consolidation cost
 * rather than carried in the export. So a file diff can be perfectly green over
 * a brain with none of them, and `test/core/export/roundtrip-file-parity.test.ts`
 * proves exactly that as a passing test: it seeds an entity card and a
 * commitment in the source brain, round-trips, and finds neither in the
 * destination while the tree digests match. Everything the product is actually
 * for is invisible to a file comparison.
 *
 * **Why it cannot live in `bun test`.** Re-consolidation makes model calls. The
 * blocking suite's defining promise is zero model calls and no egress, and a
 * gate that quietly broke that promise would make every other test in it
 * suspect. So this is the scheduled, secret-gated leg, on the same
 * `BRAINZ_REAL_SUBSTRATE` switch `eval:live-parity` uses and the same switch
 * `.github/workflows/real-substrate.yml` greps for.
 *
 * **It refuses rather than reporting a comparison it did not make.** Without the
 * substrate it prints what it would have done and exits non-zero. A gate that
 * returned success because it could not run is the precise failure this whole
 * unit is built against — the same reason `scripts/not-yet.ts` refuses loudly
 * for an unimplemented command rather than passing.
 *
 * **What is still deferred, and named rather than implied.** The legs below are
 * ordered and the fourth is the one that needs live infrastructure this session
 * may not create: provisioning a fresh tenant is a Neon project. So the run is
 * structured as a sequence of stages, each reporting `ok` / `deferred` with its
 * reason, and the command exits non-zero while any stage is deferred. That is
 * the honest state: the file-parity half is real and green in the blocking
 * suite; the knowledge half is wired, gated, and waiting on a substrate.
 */

export interface StageResult {
  readonly stage: string;
  readonly status: 'ok' | 'deferred' | 'failed';
  readonly detail: string;
}

/** The four legs R18 names, in the order they have to run. */
export const STAGES = [
  'export the source brain',
  'provision a fresh tenant',
  'import the tree through the folder path',
  're-consolidate, then score the blocking eval',
] as const;

/**
 * What this run can report, given what it can reach.
 *
 * Exported and pure so the file's own rule — *nothing here reports a stage it
 * did not run* — is a test rather than a sentence. It was a sentence, and the
 * first stage was a hardcoded `ok` underneath it: no export ran, no database was
 * opened, and a reader of the output was told a leg passed that never executed.
 * Contained, because the command exits non-zero either way and no gate goes
 * green on it — and exactly the failure this file was written against, which is
 * the reason it is not left as a comment.
 *
 * **The first stage is `deferred` for the same reason as the other three**, and
 * not as a euphemism: exporting a source brain needs a provisioned tenant with
 * content in it, which is the stage below. Where the export leg *is* proven is
 * named in its detail, so a reader is sent somewhere real instead of being
 * reassured here.
 */
export function stages(): StageResult[] {
  return [
    {
      stage: STAGES[0],
      status: 'deferred',
      detail:
        'needs the fresh tenant below to export from; the export path itself is proven on every push by test/core/export/roundtrip-file-parity.test.ts, which round-trips a real brain and compares tree digests',
    },
    {
      stage: STAGES[1],
      status: 'deferred',
      detail:
        'provisioning a fresh tenant creates a Neon project; no cloud resource is created from this environment',
    },
    {
      stage: STAGES[2],
      status: 'deferred',
      detail: 'blocked on the fresh tenant above',
    },
    {
      stage: STAGES[3],
      status: 'deferred',
      detail: 'blocked on the fresh tenant above; re-consolidation is metered model spend',
    },
  ];
}

function report(out: (line: string) => void, results: readonly StageResult[]): void {
  for (const result of results) {
    out(`  ${result.status.padEnd(8)} ${result.stage} — ${result.detail}`);
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  out('test:roundtrip — R18 knowledge parity (export → fresh tenant → re-consolidate → blocking eval)');

  if (!process.env['BRAINZ_REAL_SUBSTRATE']) {
    out('');
    out('NOT RUN — BRAINZ_REAL_SUBSTRATE is not set.');
    out('  This leg provisions a tenant and re-consolidates, which makes model calls. It is');
    out('  scheduled and secret-gated; `bun test` carries the file-parity half, which is where');
    out('  the fixed point and the digest verification are proven on every push.');
    out('');
    out('  The file-parity half is NOT a weaker version of this one. It is green while entity');
    out('  cards, salience and commitments are absent — see');
    out('  test/core/export/roundtrip-file-parity.test.ts, which asserts exactly that.');
    return 1;
  }

  // The substrate is present. Each stage reports for itself; nothing here
  // reports a stage it did not run.
  const results: StageResult[] = stages();

  out('');
  report(out, results);
  out('');

  if (argv.includes('--json')) out(JSON.stringify({ stages: results }, null, 2));

  const deferred = results.filter((result) => result.status !== 'ok');
  if (deferred.length > 0) {
    out(`${deferred.length} of ${results.length} stages could not run. Reporting deferred, not passed.`);
    return 1;
  }
  return 0;
}
