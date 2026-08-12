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

## 1. Setup

| Field | Value |
|---|---|
| Date armed (first window) | |
| Date read | |
| Deployed on (platform) | |
| Volume mounted + `PROBE_LOG_DURABLE=1`? | yes / no |
| Client under test | Claude Desktop / Claude Code / claude.ai routine |
| Client version string | |
| OS + version | |
| Beacon running during windows? | yes / no |
| Hand tests performed from | Desktop / web / both  ← if "web" or "both", discriminator 5b is void (README limit 2) |

## 2. Windows armed

| arm_id | fire_at (with offset) | window (min) | attest_away | call landed? | label matched? | verdict for this window |
|---|---|---|---|---|---|---|
| | | | | | | |
| | | | | | | |

## 3. Verdict

```
paste the `=== VERDICT: ... ===` block and the --- summary --- section here
```

**Verdict:** `UNATTENDED_CONFIRMED` / `CONSISTENT_BUT_UNPROVEN` / `NO_INVOCATION_OBSERVED` / `INFRA_FAILURE` / `NOT_RUN_YET`

**Which discriminator carried it** (README §"What counts as proof", item 5):
beacon showed machine unreachable / transport identity unseen in manual traffic / neither

**Nonces verified** (`verify-nonce` on every nonce the model reported — this is what
rules out a hallucinated tool call):

| nonce (first 12 chars) | verified? |
|---|---|
| | |

## 4. Honest caveats for THIS run

Tick every one that applies. An unticked box you cannot honestly tick is a reason the
verdict is weaker than it looks.

- [ ] Every window was armed **before** it opened (no retrofitted evidence).
- [ ] I did not interact with the client during any window.
- [ ] At least two windows were clean, on distinct days.
- [ ] The log survived at least one server restart, or sat on a mounted volume.
- [ ] Every nonce the model reported verified against the server log.
- [ ] No hand test was performed inside any window.

Anything else that could have produced this result other than an unattended invocation:

```
(write it here — if you cannot think of anything, you have not tried)
```

---

## 5. Findings for the plan  ← publishable; nothing sensitive below this line

**Assumption 3 status:** holds / fails / unsettled

**Consequence:**
- If *holds* — KTD12 and R21 stand. Briefing delivery at v1 = client scheduled tasks
  pulling `briefing`; U13 ships the recipes. No server-side push in v1.
- If *fails* — Phase 0 decision fires: the v1 delivery channel becomes a documented
  manual morning-pull recipe, and push delivery is promoted from "revisit with usage
  data" to a **Phase 4 commitment**. U12 and U13 re-scope accordingly.

**Residual risks this probe did NOT settle** (carry into U12):

1. **OAuth refresh under an unattended run.** The probe used a static secret in the URL;
   U6 step 3a specifies a bounded access-token TTL plus refresh. Whether a 07:00
   scheduled task successfully refreshes an expired grant with nobody present is
   untested and is a plausible production-only failure of the same channel.
2. **Reliability over time.** N clean days proves the path works, not its delivery rate.
   Silent disablement, client updates, and rate limits are invisible here.
3. **Tool latency.** The probe tool returned instantly; a real `briefing` doing live SQL
   assembly may exceed whatever timeout the scheduled task enforces.
4. **Client scope.** The answer is scoped to the client and version recorded above.

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
