# RESULT — Assumption 3 (client scheduled task → custom-connector MCP tool, unattended)

> **Copy this file to `RESULT.local.md` before filling it in.**
> `scripts/probes/**/*.local.*` is gitignored, so raw output (IPs, hostnames, user-agents)
> cannot reach the public repo by accident.
>
> **If you want the answer committed**, copy the "Findings for the plan" section only,
> into the plan or the concepts ledger. That section is written to be publishable: no
> IPs, no hostnames, no tokens, no user-agent strings.
>
> Fill this in the same day you read the report. The point of a probe is that the answer
> lands somewhere durable instead of scrolling past in a terminal.

---

## 0. The standard this run is being measured against

Write this out before you look at the verdict. It is the difference between reporting a
result and rationalising one.

**Proof, to the limit of this instrument:** on ≥2 independent windows (≥20 h apart,
non-overlapping, different calls), a call carrying a label minted *after* the window was
registered landed inside that window, with an away attestation, **and** at least one
discriminator held that your attestation did not produce — either the beacon absence
bracket (5a) or an unseen transport identity against a non-empty Desktop-only baseline
(5b) — **and** the instrument was sound (durable log, intact sequence, heartbeats,
connector demonstrably attached).

**Merely consistent with it:** a call in the window, honest attestation, no independent
discriminator. Indistinguishable from a call you made and forgot.

**Not reachable by this instrument at all:** that no human was in the room; and, per
README limit 8, an unattended **Desktop-local** fire — the machine must be awake to fire,
so 5b is unavailable by construction and the beacon cannot testify to the absence of a
machine that just made an HTTPS request.

## 1. Setup

| Field | Value |
|---|---|
| Date armed (first window) | |
| Date read | |
| Deployed on (platform) | |
| Volume mounted + `PROBE_LOG_DURABLE=1`? | yes / no |
| Platform scales to zero / auto-stops? | yes / no  ← if yes, cold starts land inside windows and silence is unreadable (README deploy step 3) |
| `PROBE_HEARTBEAT_SECONDS` | (default 300 / other / disabled) |
| Client under test | Claude Desktop / Claude Code / claude.ai routine |
| Where the schedule EXECUTES | on my machine / Anthropic infrastructure / unknown |
| Client version string | |
| OS + version | |
| Beacon running during windows? | yes / no — interval: ___ s |
| `--hand-tests-from` recorded as | desktop / web / both / none / unspecified  ← anything but `desktop` voids 5b in code |
| `doctor` run before arming, all green? | yes / no |

## 2. Windows armed

`window (± min)` is a **half-width**: 20 means a 40-minute window.

| arm_id | fire_at (with offset) | window (± min) | armed lead | attest_away | call landed? | label matched? | 5a beacon | 5b transport | window verdict |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |
| | | | | | | | | | |

**Qualifying (independent) windows reported:** ___ of ___ clean windows.
If clean > qualifying, the report flagged `clean_windows_are_not_independent` — say why
(too close together / overlapping / same call).

## 3. Verdict

```
paste the `=== VERDICT: ... ===` block, the --- summary --- section, and every flag here
```

**Verdict:** `UNATTENDED_CONFIRMED` / `CONSISTENT_BUT_UNPROVEN` / `NO_INVOCATION_OBSERVED`
/ `WINDOWS_STILL_OPEN` / `INCONCLUSIVE` / `NOT_RUN_YET`

**Which discriminator carried it** (`independent_via` in the report):
5a beacon absence bracket / 5b transport identity unseen / neither

**If neither: the exact `unavailable__…` reason the report printed for each.** Copy it
verbatim. "The beacon didn't work" is not a finding; `unavailable__never_resumed_after_the_call`
is.

| Window | 5a reason | 5b reason |
|---|---|---|
| | | |

**Flags, with their direction** (the report labels each):

| Flag | blocks confirmation? | blocks negative? | instrument? |
|---|---|---|---|
| | | | |

**Nonces verified** (`verify-nonce` on every nonce the model reported — this is what
rules out a hallucinated tool call):

| nonce (first 12 chars) | verified? |
|---|---|
| | |

## 4. Honest caveats for THIS run

Tick every one that applies. An unticked box you cannot honestly tick is a reason the
verdict is weaker than it looks — and if the verdict is `UNATTENDED_CONFIRMED` with an
unticked box, something is wrong with either the run or your reading of it.

- [ ] Every window was armed **≥30 minutes before** it opened (no retrofitted evidence).
- [ ] I did not interact with the client during any window.
- [ ] At least two windows were clean AND independent (≥20 h apart, different calls).
- [ ] The log sat on a mounted volume, or demonstrably survived a restart.
- [ ] Heartbeats covered every window end to end.
- [ ] The connector demonstrably attached (`tools/list` seen in the log).
- [ ] Every nonce the model reported verified against the server log.
- [ ] No hand test was performed inside any window.
- [ ] All hand tests came from Desktop, and `--hand-tests-from desktop` was recorded.
- [ ] The presence beacon ran continuously for the whole run (no dead loop, no 404s).

**The Desktop-local question, answered explicitly:** if the schedule was Desktop-local,
where did the in-window call arrive from — your machine, or a datacenter identity?

```
(if your machine: this run cannot exceed CONSISTENT_BUT_UNPROVEN. Say so plainly.
 if a datacenter identity: that is a finding — Desktop schedules execute server-side.)
```

Anything else that could have produced this result other than an unattended invocation:

```
(write it here — if you cannot think of anything, you have not tried. Start with:
 did the machine wake shortly before the call? was I on a phone? did a monitor,
 cron job, or another agent of mine touch this endpoint?)
```

---

## 5. Findings for the plan  ← publishable; nothing sensitive below this line

**Assumption 3 status:** holds / fails / unsettled

**Scope of that claim:** which client, executing where, on which dates. A pass for a
cloud-executing routine is not a pass for a Desktop-local schedule, and vice versa.

**Consequence:**
- If *holds* — KTD12 and R21 stand. Briefing delivery at v1 = client scheduled tasks
  pulling `briefing`; U13 ships the recipes. No server-side push in v1.
- If *fails* — Phase 0 decision fires: the v1 delivery channel becomes a documented
  manual morning-pull recipe, and push delivery is promoted from "revisit with usage
  data" to a **Phase 4 commitment**. U12 and U13 re-scope accordingly.
- If *unsettled* (`CONSISTENT_BUT_UNPROVEN` / `INCONCLUSIVE`) — **neither branch fires.**
  Name the one guard or instrument failure that blocked it and what it would cost to
  re-run. Do not let an unsettled probe be quoted as either answer.

**Residual risks this probe did NOT settle** (carry into U12):

1. **OAuth refresh under an unattended run.** The probe used a static secret in the URL;
   U6 step 3a specifies a bounded access-token TTL plus refresh. Whether a 07:00
   scheduled task successfully refreshes an expired grant with nobody present is
   untested and is a plausible production-only failure of the same channel.
2. **Reliability over time.** N clean windows proves the path works, not its delivery
   rate. Silent disablement, client updates, and rate limits are invisible here.
3. **Tool latency.** The probe tool returned instantly; a real `briefing` doing live SQL
   assembly may exceed whatever timeout the scheduled task enforces.
4. **Client scope.** The answer is scoped to the client and version recorded above.
5. **Human presence.** No instrument here can prove nobody was in the room; the away
   attestation is your word and is load-bearing in every verdict above.

**Protocol intel captured for U6** (from `report --json` → `summary`):

| Field | Observed |
|---|---|
| `protocol_eras_seen` | modern / legacy / both |
| `protocol_versions_seen` | |
| `spec_deviations_seen` | |

> If `legacy` appears here, **U6's `/mcp` surface cannot be modern-only.** The plan
> currently specifies stateless streamable HTTP per 2026-07-28; the spec's own
> compatibility matrix says a legacy client against a modern-only server simply fails.
> Every deviation listed is something U6 must tolerate rather than reject on day one.
