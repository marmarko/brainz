/**
 * The Verification Contract's command dispatcher.
 *
 * **Why the filename still says `not-yet`.** The plan's Verification Contract
 * says its commands are "created in U1/U7 and stay stable", and U1 delivered on
 * that by pointing every declared command at this file so that CI configuration,
 * docs and muscle memory would never have to change when an implementation
 * landed — "only the script body does". This is that change. `package.json` is
 * untouched, exactly as intended; what was a placeholder is now a router, and
 * the placeholder behaviour survives verbatim for the commands still waiting on
 * their unit.
 *
 * Two properties, and both matter:
 *
 *   - **An implemented command runs.** `bun run eval:blocking` is R6's floors,
 *     not a message about R6's floors.
 *   - **An unimplemented command still fails loudly.** `bun run test:roundtrip`
 *     prints what it printed before and exits 1. A stub that passes is worse
 *     than no stub, because it makes an unimplemented gate look green — which
 *     is the same failure every gate in this unit is built against.
 *
 * The implementations are reached by **dynamic import with a literal path**, one
 * per command. Literal so `tsc` still typechecks the modules (`evals/` is not in
 * `tsconfig.json`'s `include`, so this router is what pulls it into the
 * program); dynamic so `bun run test:roundtrip` does not load and validate the
 * eval corpus on its way to printing a two-line refusal.
 */

/** A command's entry point. The number it returns is the process's exit code. */
type CommandModule = { main(argv: readonly string[]): Promise<number> | number };

const IMPLEMENTATIONS: Readonly<Record<string, () => Promise<CommandModule>>> = {
  'eval:blocking': () => import('../evals/blocking.ts'),
  'eval:live-parity': () => import('../evals/live-parity.ts'),
  'eval:canary': () => import('../evals/canary.ts'),
  conformance: () => import('../evals/conformance/run.ts'),
};

const [command, owningUnit, ...rest] = process.argv.slice(2);

if (!command || !owningUnit) {
  console.error("usage: not-yet.ts <command-name> <owning-unit>");
  process.exit(2);
}

const implementation = IMPLEMENTATIONS[command];

if (implementation === undefined) {
  console.error(
    `\n  ${command} is declared but not implemented yet.\n` +
      `  It is owned by ${owningUnit}. See docs/plans/ for the unit's scope.\n\n` +
      `  This is a placeholder so the Verification Contract's command names stay\n` +
      `  stable from U1 onward. It exits non-zero on purpose — an unimplemented\n` +
      `  gate must never look green.\n`,
  );
  process.exit(1);
}

const module = await implementation();
process.exit(await module.main(rest));
