/**
 * Placeholder for a Verification Contract command that is declared now and
 * implemented by a later unit.
 *
 * The plan's Verification Contract says its commands are "created in U1/U7 and
 * stay stable". Declaring the names at U1 means CI configuration, docs and
 * muscle memory never have to change when the implementation lands — only the
 * script body does. Exiting non-zero (rather than silently succeeding) is
 * deliberate: a stub that passes is worse than no stub, because it makes an
 * unimplemented gate look green.
 *
 * These are intentionally NOT wired into the PR-blocking CI job yet. They fail
 * loudly when run by hand so nobody mistakes the placeholder for a passing gate.
 */

const [command, owningUnit] = process.argv.slice(2);

if (!command || !owningUnit) {
  console.error("usage: not-yet.ts <command-name> <owning-unit>");
  process.exit(2);
}

console.error(
  `\n  ${command} is declared but not implemented yet.\n` +
    `  It is owned by ${owningUnit}. See docs/plans/ for the unit's scope.\n\n` +
    `  This is a placeholder so the Verification Contract's command names stay\n` +
    `  stable from U1 onward. It exits non-zero on purpose — an unimplemented\n` +
    `  gate must never look green.\n`,
);

process.exit(1);
