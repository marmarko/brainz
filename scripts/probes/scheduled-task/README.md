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
against pre-registered firing windows and prints one of six named verdicts.

---

## The two traps this is built around

**Trap 1 — you will test the tool by hand while wiring it up.** A naive log cannot tell
that apart from the scheduled task firing at 07:00 while you were asleep — both are just
"a tool call happened". So the probe refuses to treat any invocation as evidence unless
the window was **armed first**: `arm` writes the expected fire time, a window, a secret
label, and your away-attestation into the log *before the window opens*, and at least 30
minutes before. A window armed later is flagged and can never be counted.

**Trap 2 — a missing signal is not a negative signal.** This is the one that actually
bit. Version 1 of this probe computed its "independent" discriminator as

```
independent = beacon_is_stale || transport_identity_never_seen_before
```

and **both disjuncts are satisfied by the absence of a signal.** A beacon stale because
the loop died, the terminal closed, the token rotated, or the server restarted read as
"machine absent". An empty set of known-manual identities made "never seen before"
vacuously true. So a hand test at 07:00, with the operator sitting at the keyboard,
could score CLEAN — and two such mornings produced `UNATTENDED_CONFIRMED` with zero
unattended invocations.

**Every discriminator here is now a positive test with an explicit `unavailable__…`
state, and every unavailable state fails closed.** If the instrument was degraded, the
verdict is `INCONCLUSIVE` and it names exactly what was missing. It is never a clean
window.

---

## What counts as proof, and what does not

### Proof — `UNATTENDED_CONFIRMED`

All of the following, on **at least two independent windows** — where "independent"
means ≥20 hours apart, non-overlapping, and resting on different calls (not two windows
an hour apart, and not one call satisfying two overlapping windows):

1. The window was armed **at least 30 minutes before it opened** (pre-registration).
2. A tool call landed **inside** the window.
3. That call carried the **arm-time secret label** — minted by the server at arm time and
   pasted into the scheduled prompt, so it could not have been in circulation before the
   window was registered. Extra in-window calls are tolerated *only* if they come from
   the same identity as the labelled one (a retry); an unlabelled call from anywhere
   else is exactly the shape of a hand test and disqualifies the window.
4. An **away attestation** was recorded at arm time (not afterwards).
5. At least one discriminator **independent of your attestation** held — see below.
6. The instrument was sound: durable log, intact record sequence, heartbeats, and a
   connector that demonstrably attached (`tools/list` was served at some point).

#### 5a — the beacon absence bracket

Not "the beacon was stale". Staleness is produced by five things that have nothing to do
with an absent machine. A bracket requires **all** of:

- the beacon stream was **demonstrably running** — ≥3 consecutive pings on cadence
  before it went quiet, so we know there was a live loop to go quiet;
- it had been quiet for **≥10 minutes** when the call landed;
- it **resumed afterwards** — proving the loop was alive the whole time and the silence
  was the machine, not the instrument;
- that resume came **≥10 minutes after the call**, so a machine that woke up and fired a
  catch-up task (beacon resumes within a minute of waking) does not qualify;
- no admin requests were being rejected during the quiet period (a beacon 404ing on a
  rotated token looks exactly like an absent machine);
- the server itself was up across the quiet period;
- **nothing from the beacon machine's own address touched the server at any point in
  the quiet period** — not the call, and not a hand test an hour earlier. A machine that
  just made an HTTPS request was manifestly reachable, so the beacon cannot testify to
  its absence however the timings line up.

#### 5b — the transport identity

Not "this identity is new". A new identity is what an empty log looks like. This
requires:

- a **non-empty manual baseline** — at least one tool call outside every window;
- your hand tests **recorded at arm time** as coming from Desktop (`--hand-tests-from
  desktop`). If they came from the web client, or you did not say, 5b is void: a
  cloud-scheduled run and your own claude.ai session egress from the same
  infrastructure. This used to be an honour-system checkbox in the result template; it
  is now a check in code;
- the in-window call's identity absent from operator traffic under **four** comparisons —
  exact `IP | user-agent`, a coarsened `IP/24 | ua-family`, the bare IP, and the IP
  network. The coarse forms exist because a Desktop auto-update or a DHCP renewal
  between the hand test and the window would otherwise *manufacture* the discriminator;
  the bare-IP forms exist because the beacon runs under `curl` and the MCP client does
  not, so on one machine the full tuples differ while the address does not.

Operator traffic means: every presence beacon (posted by your machine by construction),
every out-of-window tool call, and every out-of-window JSON-RPC request. Version 1 built
this set from out-of-window tool calls alone and ignored the rest, which is how an empty
set was reachable at all.

### Merely consistent — `CONSISTENT_BUT_UNPROVEN`

A call landed in a closed window but at least one guard is unmet. Common shapes:

- One qualifying window only. Two are required, because a single hit does not
  distinguish "it fires" from "it fired once".
- No independent discriminator: both 5a and 5b came back `unavailable__…`. The report
  prints which, and why.
- No away attestation, or the window was armed late.

**This is not a pass.** It is a true statement about a call you say you did not make —
and it is indistinguishable from a call you made and forgot. Fix the named guard,
re-arm, and do not cite it in the plan either way.

### Not evidence at all

- **A transcript claiming the tool was called, with no matching nonce in the log.** This
  is the hallucination class: a model saying "I've fetched your briefing" reads exactly
  like success. `verify-nonce <nonce>` closes it — the nonce is minted server-side per
  call, so a nonce that does not appear in the log was never issued. Run it on every
  reported nonce.
- A call whose timestamp is near the scheduled time but which was armed for retroactively.
- A manual test performed at the scheduled time "to check it works".
- Anything at all when the verdict is `INCONCLUSIVE`.

---

## What this probe cannot prove (read before writing the result)

1. **It cannot observe the room.** "Unattended" ultimately means no human was involved,
   and no HTTP server can see that. The beacon proves your *machine* was unreachable, not
   that *you* were asleep — you could be on a phone. Item 4 (attestation) is load-bearing
   and it is your word. The probe's honest claim is: *the call did not come from this
   machine while it was reachable, at a time registered in advance, carrying a label
   minted after registration.*
2. **Transport alone never separates manual-web from scheduled-cloud.** A cloud-scheduled
   run (claude.ai / Claude Code routines) egresses from Anthropic infrastructure — which
   differs from your home IP but is *identical to your own manual claude.ai usage*.
   **Do your hand tests from Desktop, not the web, and record that with
   `--hand-tests-from desktop`.** Anything else voids 5b in code.
3. **Two windows is a floor, not an SLA.** A pass shows the invocation path *works*, not
   that it is reliable. Silent disablement, a missed day, a client update, or a rate
   limit are all invisible here. U12's re-verification against the real `briefing`
   connector still stands.
4. **This server has no OAuth, and the real one will (U6 step 3a).** The probe
   authenticates with a static secret in the connector URL. brainz v1 mints a per-tenant
   bearer with a **bounded access-token TTL plus refresh**. "Does an unattended scheduled
   task successfully refresh an expired grant at 07:00 with nobody there to approve it?"
   is a *different question this probe does not answer* — and it is a plausible way for
   the delivery channel to fail in production after passing here. **Record it as a
   residual risk for U12.**
5. **The answer is scoped to the client versions you tested, on the date you tested.**
   Log the version strings; the report prints them.
6. **It proves invocation, not prompt adherence.** A missing label on a *retry* is
   tolerated deliberately; the label is a binding device, not a score.
7. **The log is tamper-EVIDENT, not tamper-proof.** `seq` continuity and
   `records_at_boot` monotonicity detect truncation, a wiped volume, and torn writes —
   the accidents that actually happen. They do not defend against the operator, who
   holds the file. This is a self-deception audit, not an adversarial one.
8. **A Desktop-LOCAL schedule cannot reach `UNATTENDED_CONFIRMED` through this
   instrument, and that is not a bug.** The machine must be awake to fire, so:
   - 5b is unavailable by construction — the call comes from your own machine;
   - 5a is unavailable by construction — the call came from the beacon machine itself,
     so the beacon cannot testify to its absence. Even if it could, a system that woke on
     a scheduled wake and a system whose lid you opened are the same signal.

   The best a Desktop-local run can honestly reach is `CONSISTENT_BUT_UNPROVEN`. **If a
   task you configured in Desktop arrives from a datacenter identity, that is a finding,
   not a confusion** — it means Desktop schedules execute server-side, which is *better*
   news for the assumption (it would survive a closed laptop) and puts 5b back in play.
   The report surfaces the identity of every call; read it rather than assuming.
9. **The probe tool returns instantly.** A real `briefing` that takes 30s could time out
   inside a scheduled task. Not covered.
10. **Optional beacon idle fields are recorded, never counted.** If your beacon posts
    `user_idle_seconds` / `screen_locked`, they are stored on the beacon record and
    visible in `report --json`. They never qualify a window: they are measured by the
    machine under test, their behaviour across sleep/wake is unverified, and an untouched
    laptop with the lid open produces the same reading as an absent operator.

---

## Environment variables

| Variable | Required for | Default | What it is |
|---|---|---|---|
| `PROBE_MCP_TOKEN` | server | **none — refuses to start** | Unguessable secret in the connector URL: `https://<host>/mcp/<PROBE_MCP_TOKEN>`. This is what makes a public endpoint safe to leave up. |
| `PROBE_ADMIN_TOKEN` | server, `doctor`, `arm`, `report`, `verify-nonce` | **none — refuses to start** | Bearer for `/probe/arm`, `/probe/records`, `/probe/beacon`. Must differ from `PROBE_MCP_TOKEN` (the MCP token is handed to a third party; this one is not). |
| `PROBE_BASE_URL` | `doctor`, `arm`, `report`, `verify-nonce` | none | Public HTTPS origin of the deployed probe, e.g. `https://brainz-probe.up.railway.app`. |
| `PROBE_LOG_PATH` | server | `./probe-log.local.jsonl` beside `serve.ts` | Append-only JSONL log. **Point this at a mounted volume.** The `.local.` in the default name is what keeps it out of git. |
| `PROBE_LOG_DURABLE` | server | unset (false) | Set to `1` once `PROBE_LOG_PATH` is on durable storage. Unproven durability now **blocks both verdicts** — see the deploy note below. |
| `PROBE_HEARTBEAT_SECONDS` | server | `300` | Interval for the liveness records that let the report assert the server was up across a window. `0` disables them, which makes `NO_INVOCATION_OBSERVED` unreachable. |
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
   Skipping this is the single most likely way to get a meaningless answer — and not
   only because you might lose a negative. A wiped log also empties the manual-identity
   baseline that 5b compares against, which is precisely how an attended call scores as
   unattended. Unproven durability therefore blocks *both* verdicts.
3. **Disable scale-to-zero / set a minimum instance count.** Render's free tier, Fly
   auto-stop and Cloud Run's default all idle the container. On those the 07:00 call is
   what *wakes* the container, so a cold-start boot record lands inside every window and
   the heartbeat stream has a hole across it. The probe no longer treats that as
   window-invalidating for a call that did land, but it does make silence unreadable.
4. Generate a public domain. That origin is `PROBE_BASE_URL`.

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

**4. Start the presence beacon** on your laptop, in a terminal you leave running.
Note the `set -a` line: `bun run` auto-loads `.env`, but a bare `curl` in your shell does
not, and an unexported `PROBE_ADMIN_TOKEN` gives you a silent 404 loop that kills 5a for
the whole run.

```bash
set -a; source .env; set +a          # or export the two variables by hand
while true; do
  curl -fsS -X POST "$PROBE_BASE_URL/probe/beacon" \
    -H "authorization: Bearer $PROBE_ADMIN_TOKEN" \
    -H 'content-type: application/json' -d '{"host_label":"laptop"}' > /dev/null \
    || echo "[beacon] FAILED at $(date -u +%FT%TZ) — 5a is dead until this is fixed" >&2
  sleep 120
done
```

Two minutes, not five: the absence bracket needs a presence *timeline*, and the log
records at most one beacon per minute. Without this loop, 5a is unavailable — which
fails closed, not open.

**5. Run `doctor` before you arm anything.** It checks every wiring failure that would
otherwise surface as an undifferentiated 404 the morning after:

```bash
bun run probe:scheduled-task doctor
```

**6. Arm the window, then schedule the task:**

```bash
bun run probe:scheduled-task arm \
  --client code \
  --fire-at 2026-08-13T07:00:00-07:00 \
  --window-minutes 20 \
  --hand-tests-from desktop \
  --attest-away
```

- `--fire-at` **must** carry an explicit offset or `Z`; a naive timestamp is a timezone
  false-fail waiting to happen. The window must open at least 30 minutes from now.
- `--window-minutes` is a **half-width**: `20` means `fire_at ± 20 min`, a 40-minute
  window. It is capped at 120, because wide windows on consecutive days overlap and one
  call can then satisfy two of them.
- `--attest-away` is your assertion that you will not touch the client during the window.
  Without it the run can never reach `UNATTENDED_CONFIRMED`.
- `--hand-tests-from` records where your by-hand tests came from. Anything other than
  `desktop` voids 5b for that window (limit 2). Unspecified is treated as void, because
  an unrecorded answer is not an answer.

`arm` prints the exact prompt to paste into the scheduled task, carrying the freshly
minted label. **This doubles as the first draft of the R21 recipe.** It reads:

> Call the `probe_briefing` tool on the brainz probe connector with `run_label` set to
> `"run-xxxxxxxxxxxx"`. Then output, verbatim and each on its own line, the `record_id`
> and `nonce` values the tool returned. Do not summarise or paraphrase them. If the tool
> call fails, output the exact error text instead.

**7. Go away.** Two independent windows are required, so repeat step 6 for a second day
at least 20 hours later.

What "go away" should mean depends on where the schedule executes, and the previous
version of this document got it wrong:

- **Cloud-executing client (Claude Code / claude.ai routines).** Let the laptop sleep.
  The call arrives from Anthropic infrastructure while your machine is demonstrably
  unreachable across *and after* the call — 5a and 5b both carry. This is the
  configuration that can actually reach a pass.
- **Desktop-local schedule.** Letting the machine sleep does **not** manufacture 5a.
  The old advice — "let it sleep, the machine wakes to fire, the call arrives with a
  stale beacon, that is discriminator 5a" — was the headline false-positive: a machine
  that wakes at 07:05 because you opened the lid, and runs a catch-up task at 07:06,
  produces exactly that reading. The probe now refuses it on two grounds (the beacon
  resumed within 10 minutes of the call, and the call came from the beacon machine
  itself). Run it anyway — the useful outcome is the *identity* of the in-window call.
  If it arrives from a datacenter IP, Desktop schedules execute server-side and 5b is
  live. If it arrives from your own machine, this instrument tops out at
  `CONSISTENT_BUT_UNPROVEN` and you should say so in the result rather than dressing it
  up.

**8. Read the verdict, after the last window has closed:**

```bash
bun run probe:scheduled-task report          # human
bun run probe:scheduled-task report --json   # machine
```

Running it early is safe and useful — it returns `WINDOWS_STILL_OPEN` and prints the
flags you still have time to fix. It is not a result.

---

## Reading the output

The report prints a verdict, a summary, global flags, a per-window breakdown showing
which guards held and which did not, and a plain statement of what would constitute
proof versus what is merely consistent with it.

| Verdict | Meaning | What the plan does |
|---|---|---|
| `UNATTENDED_CONFIRMED` | Every guard held on ≥2 independent windows, and the instrument was sound. | **Assumption 3 holds**, to the limit stated in limits 1–3. KTD12/R21 stand: ship recipes (U13), no server-side push in v1. Carry limits 3 and 4 into U12 as residual risk. |
| `CONSISTENT_BUT_UNPROVEN` | A call landed in a closed window; a guard is unmet. | **Not an answer.** Fix the named guard, re-arm, re-run. Never cite as evidence either way. |
| `NO_INVOCATION_OBSERVED` | Every window closed empty, the server was **demonstrably** up across them, and nothing in the log could have hidden a real fire. | **Evidence against.** Re-run once to rule out a one-off, then take the Phase 0 decision: documented manual morning-pull recipe, and push delivery promoted from "revisit later" to a **Phase 4 commitment**. |
| `WINDOWS_STILL_OPEN` | At least one armed window has not closed. | **Not a result — the run is not finished.** Fix any printed flags *now*, before the window opens. |
| `INCONCLUSIVE` | The instrument was degraded: log durability unproven, record sequence broken, log shrank across a restart, no heartbeats, or the connector never attached. | **Says nothing about Assumption 3.** Fix what is named and re-run. Recording this as a failure of the assumption is the expensive mistake. |
| `NOT_RUN_YET` | No arming records. | Arm before the task fires. |

### Flags carry a direction

Every flag declares which verdicts it makes unsafe, and the verdict function honours
both. This replaces v1's asymmetry, where flags were computed, printed, and then could
only be *described* as invalidating a negative:

- `blocks UNATTENDED_CONFIRMED` — this could make an attended call look unattended.
- `blocks NO_INVOCATION_OBSERVED` — this could have hidden a real fire.
- `blocks BOTH` — the log itself cannot be trusted.
- `informational` — recorded, reported, invalidates nothing.

Ambient traffic the server tolerates by design is **informational**: internet-scanner
404s on unrelated paths, a legacy `GET`/`DELETE` on the MCP endpoint (a dual-era client
opening the optional server→client stream does this on every legitimate connection), and
an unknown JSON-RPC method answered with `200 + -32601`. v1 disqualified a window for any
of these, which meant one bot in a 40-minute window killed the day and re-arming
reproduced it exactly.

### Per-client evidence table

The discriminator that carries the proof differs by where the schedule executes. The
report prints this per window, from the recorded `client` and `hand_tests_from`.

| Client | Where it fires from | Transport vs your hand tests | What can carry the proof |
|---|---|---|---|
| Claude Code / claude.ai routines (cloud) | Anthropic infrastructure | Different from Desktop hand tests → 5b is strong. Identical to *web* hand tests → 5b is void, in code. | 5b (hand tests confined to Desktop) and/or 5a (machine unreachable across and after the call). |
| Claude Desktop (local) | Your machine | Same address as your hand tests → 5b unavailable by construction. | **Nothing, by construction** — see limit 8. Tops out at `CONSISTENT_BUT_UNPROVEN` unless the call turns out to arrive from a datacenter identity. |

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
in a measurement instrument — and the analyser is written to match that posture rather
than punish it.

---

## Teardown

The probe is throwaway. When the result is recorded in `RESULT.local.md`: delete the
connector from the client, delete the deployment, and rotate nothing — the tokens die
with it. Keep the filled-in result; that is the artifact the plan cites.
