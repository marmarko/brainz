# Probe: can a client scheduled task invoke a custom-connector MCP tool unattended?

Phase 0 cheap-check for **Assumption 3** of
`docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md`:

> Claude Desktop and Claude Code scheduled tasks can invoke a custom-connector MCP tool
> unattended.

This is the entire v1 briefing delivery channel (**KTD12**: briefing delivery at v1 =
client scheduled tasks pulling `briefing`; **R21**: recipes are docs + prompts, not a
server-side scheduler). If it fails, brainz v1 is *"ask for a briefing"* rather than
*"wake up to one"* — a different product. The plan wants that surfaced as a Phase 0
decision, not a Phase 3 discovery, which is why this costs an evening instead of a
sprint.

The probe is a throwaway, dependency-free, **dual-era** MCP server exposing one tool
(`probe_briefing`). Every invocation appends a record to an append-only JSONL log:
server-clock timestamp, a server-minted nonce the caller cannot forge, and every scrap
of caller identity the transport actually reveals. `report` then classifies that log
against pre-registered firing windows and prints one of five named verdicts.

---

## The trap this is built around

**You will test the tool by hand while wiring it up.** A naive log cannot tell that
apart from the scheduled task firing at 07:00 while you were asleep — both are just
"a tool call happened". A probe that counts your hand test as proof of unattended
invocation certifies the assumption **falsely**, and the plan then ships a delivery
channel that does not exist.

So the probe refuses to treat any invocation as evidence unless it was **armed first**.
`arm` writes the expected fire time, a window, a secret label, and your away-attestation
into the log *before the window opens*. A window armed after it opened is flagged
`armed_after_window_opened__evidence_is_retrofitted` and can never be counted — because
at that point you are fitting a story to a call you already saw.

**False fails cost as much as false passes.** A false fail promotes server-side push
from "revisit later" to a Phase 4 commitment that was never needed. So the server is
deliberately lenient — it never rejects a request for spec non-compliance, it speaks
both protocol eras, and it logs every request it *refuses*, so "the client tried and
failed" can never be misread as "the client never tried".

---

## What counts as proof, and what does not

### Proof — `UNATTENDED_CONFIRMED`

All of the following, on **at least two distinct days**:

1. The window was armed **before** it opened (pre-registration, so nothing is retrofitted).
2. A tool call landed **inside** the window.
3. That call carried the **arm-time secret label** — a string minted by the server after
   arming and pasted into the scheduled prompt, so it could not have been in circulation
   before the window was registered.
4. An **away attestation** was recorded at arm time (not afterwards).
5. At least one discriminator **independent of your attestation** held:
   - the presence beacon showed your machine unreachable at fire time, **or**
   - the call's transport identity (client IP + user-agent) appears on **no**
     out-of-window call — i.e. it is not the identity your hand tests come from.
6. No infrastructure noise in the window (no restart, no rejected request, no JSON-RPC error).

### Merely consistent — `CONSISTENT_BUT_UNPROVEN`

A call landed in the window but at least one guard above is unmet. Common shapes:

- One clean day only. Two are required, because a single hit cannot be told from a
  coincidence and does not distinguish "it fires" from "it fired once".
- The call came from the same IP + user-agent as your hand tests, with the beacon showing
  the machine awake. Consistent with a scheduled fire; equally consistent with you
  triggering it and forgetting.
- No away attestation.
- The label matched but the window was armed late.

**This is not a pass.** Fix the one unmet guard and re-arm. Do not cite it in the plan.

### Not evidence at all

- **A transcript claiming the tool was called, with no matching nonce in the log.** This
  is the hallucination class: a model saying "I've fetched your briefing" reads exactly
  like success. `verify-nonce <nonce>` closes it — the nonce is minted server-side per
  call, so a nonce that does not appear in the log was never issued, and the claim is
  unsupported. Run it on every reported nonce.
- A call whose timestamp is near the scheduled time but which was armed for retroactively.
- A manual test performed at the scheduled time "to check it works".

---

## What this probe cannot prove (read before writing the result)

1. **It cannot observe the room.** "Unattended" ultimately means no human was involved,
   and no HTTP server can see that. The beacon proves your *machine* was unreachable, not
   that *you* were asleep — you could be on a phone. Item 4 (attestation) is load-bearing
   and it is your word. The probe's honest claim is: *the call did not come from this
   machine while it was awake, at a time registered in advance, carrying a label minted
   after registration.*
2. **Transport alone never separates manual-web from scheduled-cloud.** A cloud-scheduled
   run (claude.ai / Claude Code routines) egresses from Anthropic infrastructure — which
   differs from your home IP but is *identical to your own manual claude.ai usage*.
   If you hand-test from the web client, discriminator 5b evaporates and the window +
   label + attestation carry the whole load. **Do your hand tests from Desktop, not the
   web, so the cloud identity stays clean.**
3. **Two days is a floor, not an SLA.** A pass shows the invocation path *works*, not that
   it is reliable. Silent disablement, a missed day, a client update, or a rate limit are
   all invisible here. U12's re-verification against the real `briefing` connector still
   stands.
4. **This server has no OAuth, and the real one will (U6 step 3a).** The probe
   authenticates with a static secret in the connector URL. brainz v1 mints a per-tenant
   bearer with a **bounded access-token TTL plus refresh**. "Does an unattended scheduled
   task successfully refresh an expired grant at 07:00 with nobody there to approve it?"
   is a *different question this probe does not answer* — and it is a plausible way for
   the delivery channel to fail in production after passing here. **Record it as a
   residual risk for U12.**
5. **The answer is scoped to the client versions you tested, on the date you tested.**
   Log the version strings; the report prints them.
6. **It proves invocation, not prompt adherence.** That the model called the tool at all
   is what is being measured. A label match is partial evidence it followed the recipe.
7. **The probe tool returns instantly.** A real `briefing` that takes 30s could time out
   inside a scheduled task. Not covered.

---

## Environment variables

| Variable | Required for | Default | What it is |
|---|---|---|---|
| `PROBE_MCP_TOKEN` | server | **none — refuses to start** | Unguessable secret in the connector URL: `https://<host>/mcp/<PROBE_MCP_TOKEN>`. This is what makes a public endpoint safe to leave up. |
| `PROBE_ADMIN_TOKEN` | server, `arm`, `report`, `verify-nonce` | **none — refuses to start** | Bearer for `/probe/arm`, `/probe/records`, `/probe/beacon`. Must differ from `PROBE_MCP_TOKEN` (the MCP token is handed to a third party; this one is not). |
| `PROBE_BASE_URL` | `arm`, `report`, `verify-nonce` | none | Public HTTPS origin of the deployed probe, e.g. `https://brainz-probe.up.railway.app`. |
| `PROBE_LOG_PATH` | server | `./probe-log.local.jsonl` beside `serve.ts` | Append-only JSONL log. **Point this at a mounted volume.** The `.local.` in the default name is what keeps it out of git. |
| `PROBE_LOG_DURABLE` | server | unset (false) | Set to `1` once `PROBE_LOG_PATH` is on durable storage. Purely an assertion — but if the log survives a restart the report *demonstrates* durability from the boot records and stops warning. |
| `PORT` | server | `8787` | Injected by most platforms. |

**The server never auto-generates the two secrets.** A restart that silently rotated the
token would break the connector URL, and the resulting silence would read as "the
scheduled task didn't fire" — a false FAIL. Generate them once:

```bash
echo "PROBE_MCP_TOKEN=$(openssl rand -hex 24)"
echo "PROBE_ADMIN_TOKEN=$(openssl rand -hex 24)"
```

Keep them out of the repo — this repo is public. Set them in the platform's variable UI,
or in a local `.env` (already gitignored). Nothing secret ever reaches the log: the
connector path is stored as `/mcp/<redacted>`, `Authorization` values are stored only as
a SHA-256 prefix, and any occurrence of either token in any captured string is scrubbed
at write time. A log line is safe to paste into a result doc.

---

## Deploy

A custom connector cannot reach `localhost`, so this needs a public HTTPS origin.

### Any Docker host (Railway, Fly, Render, Cloud Run)

The `Dockerfile` here is self-contained — one file, no dependencies, no lockfile.
**Build with this directory as the context**, not the repo root (the repo-root
`.dockerignore` excludes `scripts/`):

```bash
docker build -t brainz-probe scripts/probes/scheduled-task/
```

On Railway/Render, set the service's **root directory** to
`scripts/probes/scheduled-task` and it will find this Dockerfile. Then:

1. Set `PROBE_MCP_TOKEN` and `PROBE_ADMIN_TOKEN` in the service variables.
2. **Mount a volume at `/data`** and set `PROBE_LOG_DURABLE=1`.
   Skipping this is the single most likely way to get a meaningless answer.
3. Generate a public domain. That origin is `PROBE_BASE_URL`.

### Fallback: local + tunnel

```bash
bun run probe:scheduled-task            # in one terminal
cloudflared tunnel --url http://localhost:8787
```

Workable but weaker: your laptop must stay awake all night, which destroys the beacon
discriminator (5a) and adds a way for the probe to be down exactly when the task fires.
Prefer a real host.

---

## Operating procedure

**1. Deploy** and confirm it is up: `curl https://<host>/` prints a status line.

**2. Add the custom connector** in Claude Desktop / Claude Code, URL:

```
https://<host>/mcp/<PROBE_MCP_TOKEN>
```

**3. Hand-test it once, from Desktop** (`"call the probe_briefing tool"`). This is
expected and useful — it establishes your manual transport identity, which is what
discriminator 5b later compares against. Do not hand-test from the web client (see
limit 2). Verify it landed:

```bash
bun run probe:scheduled-task verify-nonce <the nonce the model reported>
```

**4. Start the presence beacon** on your laptop, in a terminal you leave running:

```bash
while true; do
  curl -fsS -X POST "$PROBE_BASE_URL/probe/beacon" \
    -H "authorization: Bearer $PROBE_ADMIN_TOKEN" \
    -H 'content-type: application/json' -d '{"host_label":"laptop"}' > /dev/null
  sleep 300
done
```

When the machine sleeps the pings stop, and the probe records how stale the beacon was at
the moment of each call. Optional, but without it discriminator 5a is unavailable.

**5. Arm the window, then schedule the task:**

```bash
bun run probe:scheduled-task arm \
  --client desktop \
  --fire-at 2026-08-13T07:00:00-07:00 \
  --window-minutes 20 \
  --attest-away
```

`--fire-at` **must** carry an explicit offset or `Z`; a naive timestamp is a timezone
false-fail waiting to happen. `--attest-away` is your assertion that you will not touch
the client during the window — without it the run can never reach
`UNATTENDED_CONFIRMED`.

`arm` prints the exact prompt to paste into the scheduled task, carrying the freshly
minted label. **This doubles as the first draft of the R21 recipe.** It reads:

> Call the `probe_briefing` tool on the brainz probe connector with `run_label` set to
> `"run-xxxxxxxxxxxx"`. Then output, verbatim and each on its own line, the `record_id`
> and `nonce` values the tool returned. Do not summarise or paraphrase them. If the tool
> call fails, output the exact error text instead.

**6. Go away — and if the schedule is Desktop-local, let the machine sleep.** Two clean
days are required, so repeat step 5 for a second day.

Leaving the laptop awake all night is the one "cautious" choice that guarantees an
unprovable result: a Desktop-local task then fires from the same identity as your hand
tests (5b dead) while the beacon keeps pinging (5a dead), so `independent_discriminator`
is false and the run can only ever reach `CONSISTENT_BUT_UNPROVEN`. Let it sleep: the
beacon goes stale, the machine wakes to fire, and the call arrives with a stale beacon —
which is exactly discriminator 5a. If you cannot let it sleep, read the identity the
report prints for the in-window call: should the scheduled runner present a distinct
user-agent, or fire from a datacenter IP, 5b revives on its own.

**7. Read the verdict:**

```bash
bun run probe:scheduled-task report          # human
bun run probe:scheduled-task report --json   # machine
```

---

## Reading the output

The report prints a verdict, a summary, global flags, and a per-window breakdown showing
which guards held and which did not (`unmet:` lines name the exact missing thing).

| Verdict | Meaning | What the plan does |
|---|---|---|
| `UNATTENDED_CONFIRMED` | Every guard held on ≥2 days. | **Assumption 3 holds.** KTD12/R21 stand: ship recipes (U13), no server-side push in v1. Carry limits 3 and 4 above into U12 as residual risk. |
| `CONSISTENT_BUT_UNPROVEN` | A call landed in the window; a guard is unmet. | **Not an answer.** Fix the named guard, re-arm, re-run. Never cite as evidence either way. |
| `NO_INVOCATION_OBSERVED` | Windows opened and closed, server healthy, nothing arrived. | **Evidence against.** Re-run once to rule out a one-off, then take the Phase 0 decision: documented manual morning-pull recipe, and push delivery promoted from "revisit later" to a **Phase 4 commitment**. |
| `INFRA_FAILURE` | Restart inside a window, rejected requests, connector never attached, or log durability unproven. | **Says nothing about Assumption 3.** Fix the probe and re-run. Recording this as a failure of the assumption is the expensive mistake. |
| `NOT_RUN_YET` | No arming records. | Arm before the task fires. |

### Per-client evidence table

The discriminator that carries the proof differs by where the schedule executes.

| Client | Where it fires from | Transport vs your hand tests | What carries the proof |
|---|---|---|---|
| Claude Code / claude.ai routines (cloud) | Anthropic infrastructure | Different from Desktop hand tests → 5b is strong. Identical to *web* hand tests → 5b is worthless. | 5b, if you hand-tested only from Desktop. Otherwise window + label + attestation. |
| Claude Desktop (local) | Your machine | Same IP and likely same user-agent as hand tests → 5b unavailable. | 5a (beacon showing the machine unreachable) + window + label + attestation. **Requires the machine to sleep overnight** — see step 6. |

**If a task you configured in Desktop arrives from a datacenter IP, that is a finding,
not a confusion** — it means Desktop schedules execute server-side, which is *better*
news for the assumption (it would survive a closed laptop). The report surfaces the
identity of every call; read it rather than assuming.

---

## What you get for free, beyond the verdict

The report also prints, from real client traffic, answers U6 needs anyway:

- `protocol_eras_seen` — does the client speak modern (2026-07-28, per-request `_meta`)
  or legacy (`initialize` handshake)? **U6's `/mcp` surface must serve whichever this
  says**, and the plan currently specifies modern-only.
- `protocol_versions_seen` — the exact revision strings.
- `spec_deviations_seen` — every place real traffic departs from the 2026-07-28 spec
  (missing `Mcp-Method`, absent `MCP-Protocol-Version`, a legacy `Mcp-Session-Id`, an
  `Accept` header lacking `text/event-stream`, …). This is the list of things U6 must not
  enforce strictly on day one.
- `distinct_client_identities` — the egress identities to expect.

---

## Non-goals

Deliberately absent; do not add them: OAuth (authorization server, DCR, PKCE), SSE
streaming, `subscriptions/listen`, MRTR / `InputRequiredResult`, `x-mcp-header`, rate
limiting, any persistence beyond a JSONL file. This probe settles one question. U6 builds
the real surface.

**One deliberate spec deviation:** an unknown JSON-RPC method returns HTTP 200 with a
`-32601` error body, where 2026-07-28 says a modern server returns HTTP 404. A 404 can
send a dual-era client down the deprecated HTTP+SSE fallback path, which would fail the
probe for a reason having nothing to do with scheduled tasks. Leniency beats compliance
in a measurement instrument.

---

## Teardown

The probe is throwaway. When the result is recorded in `RESULT.local.md`: delete the
connector from the client, delete the deployment, and rotate nothing — the tokens die
with it. Keep the filled-in result; that is the artifact the plan cites.
