# Contributing to brainz

brainz is AGPL-3.0-only and public from its first commit. Contributions are
welcome; a few things are worth knowing before you open a PR.

## Developer Certificate of Origin

Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/) (DCO)
rather than a CLA. Sign off every commit:

```bash
git commit -s -m "feat(scope): what changed"
```

That adds a `Signed-off-by:` trailer, which certifies you wrote the patch or
otherwise have the right to submit it under the project's licence.

## The repo is public and touches real credentials

The working tree references credentials that unlock a real mailbox. A single
committed `.env` is instantly public and effectively unrevocable — you cannot
un-publish a secret, only rotate it.

So:

- **Never commit a credential**, not even to a branch you plan to rebase.
- GitHub secret scanning with push protection and a gitleaks CI job are the
  controls. `.gitignore` is a convenience, not a control.
- If you believe a secret was committed, say so immediately rather than quietly
  force-pushing — rotation matters more than the commit history looking clean.

## Three ledgers CI enforces

**`upstream/concepts.jsonl`** — every capability from the parity audit carries a
classification: `covered`, `not-yet(priority)`, or `omitted(reason, revisit_by)`.
CI fails on an unclassified row and on a `revisit_by` date that has passed. The
point is that nothing gets dropped silently; a capability can be declined, but
not forgotten.

**`docs/porting-hazards.md`** — failure modes that are invisible in development
and only surface on real data. Each unguarded hazard ships as a skipped test in
`test/hazards/` with a reason string, so the suite prints how many are known and
not yet guarded.

If your change closes a hazard, replace its skipped stub with a real behavioural
test and update the card's status. If your change introduces a capability the
ledger lists as `not-yet`, flip its row in the same PR.

**`docs/register.md`** — every component shared by more than one user, with its
blast radius and its rotation owner (R10). It is generated from
`src/register/components.ts` and checked for completeness against three things
the register does not author: every `http(s)://` host named anywhere in `src/`,
every model provider a routing profile can reach, and every binding
`wrangler.toml` declares.

### Register review — the PR checklist item

> **Register (R10).** If this PR adds or changes a component shared by more than
> one user — a vendor, a model provider, a fleet, a queue, a credential —
> `docs/register.md` names it with its blast radius and rotation owner.

`bun test test/register/` fails on a component the code names and the register
does not, and on an entry claiming something the code no longer has. The human
half of the review is the checklist line above: the machine can tell you a vendor
is unnamed, and it cannot tell you whether the blast radius you wrote for it is
true.

**Adding a model provider is the case to slow down on.** KTD13 admits exactly two
model-side processors, and every other content-touching op runs open weights on
Cloudflare's own plane. A third provider is a register change *and* a
subprocessor-list change, not a config edit — the register exists to make that
cost visible before it is paid.

After changing the register, regenerate the document:

```bash
bun -e 'import {REGISTER_DOC_PATH,renderRegister,spliceRegister} from "./src/register/render.ts"; \
  await Bun.write(REGISTER_DOC_PATH, spliceRegister(await Bun.file(REGISTER_DOC_PATH).text(), renderRegister()))'
```

## Tests

```bash
bun install
bun run typecheck
bun test
bun run ledger:check
```

The blocking suite makes **zero model calls and no network egress** — that is
what makes it deterministic and what lets fork PRs run it. Anything needing a
live substrate or a real model belongs in the scheduled, secret-gated workflow,
never in the PR path.

When you add a behaviour-bearing change, write the test first and watch it fail.
A test that has never been red has not been shown to test anything.

## Plans

Substantial work is planned before it is built. Plans live in `docs/plans/` and
carry the requirements, technical decisions and verification contract the work is
measured against. If you are proposing something large, open an issue first —
it is cheaper to disagree about a plan than about a branch.
