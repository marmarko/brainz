/**
 * R10's register: every component shared by more than one user, as data.
 *
 * **Why this is a module and `docs/register.md` is generated from it.** The
 * requirement has two halves that pull apart if the artifact is a hand-written
 * table — *machine-readable*, and *an outsider can audit the blast radius
 * without reading the source*. Prose is what an outsider reads and prose is what
 * drifts. So the register is data here, rendered there, checked fresh by test,
 * and checked for **completeness against the code** by `completeness.ts` — which
 * is the half that matters, because a register compared to its own rendering is
 * complete by construction and can still be wrong in fact.
 *
 * **What earns an entry.** Anything one user's data or one user's availability
 * depends on that another user's also depends on. That includes the obvious
 * vendors, and it includes three things it is tempting to treat as invisible:
 *
 *   * **Cloudflare**, which is fleet host, container platform *and* the AI
 *     Gateway every model call transits. It is the broadest `>1-user` component
 *     in the system and it gets a row rather than being background.
 *   * **Platform credentials**, each of which is a key whose holder reaches
 *     every tenant — the Neon org key, the object-storage parent credential, the
 *     Pipedream project key, the hosted provider keys, and the attestation
 *     signing key, whose holder can forge an isolation receipt for anyone.
 *   * **The attestation signing key's custody**, which R10 is explicit is not
 *     the same act as naming its blast radius. Its entry carries the custody
 *     model, the published verification key, and the rotation and revocation
 *     procedure — and says plainly that no real key exists yet.
 *
 * **`transmits_user_content` is the shorter list, and it is the point.** KTD13
 * admits exactly two model-side processors — the embedding provider and the
 * extraction/enrichment provider — and keeps every other content-touching model
 * op on Cloudflare's hosted plane, open weights on Cloudflare GPUs with no proxy
 * to the model's originating lab. A third one is a register change *and* a
 * subprocessor-list change, not a config edit, and the register is what makes
 * that cost visible before it is paid.
 */

export type ComponentKind =
  | 'substrate'
  | 'fleet'
  | 'control-plane'
  | 'web-app'
  | 'vendor'
  | 'model-provider'
  | 'platform-credential'
  | 'client'
  | 'public-data';

/** Whose data the component touches. The "more than one user" test, stated. */
export type SharedBy = 'all_tenants' | 'some_tenants' | 'one_tenant' | 'no_tenant_data';

export interface RegisterEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: ComponentKind;
  readonly shared_by: SharedBy;
  /** Does a user's own content reach it? Distinct from "does it exist for them". */
  readonly transmits_user_content: boolean;
  /** What an attacker who holds or owns this reaches. */
  readonly blast_radius: string;
  readonly rotation_owner: string;
  readonly rotation: string;
  /** What in the code proves this exists. `completeness.ts` checks both ways. */
  readonly evidence: {
    readonly hosts?: readonly string[];
    readonly providers?: readonly string[];
    readonly bindings?: readonly string[];
  };
  /** Anything a reader would otherwise have to take on trust. */
  readonly note?: string;
}

export interface NotADestination {
  readonly host: string;
  readonly reason: string;
}

/**
 * Hosts a source file names that nothing is ever sent to.
 *
 * The host scan is deliberately crude — a literal match, so a URL in a comment
 * counts. Over-reporting is the correct direction of error for a blast-radius
 * list, and this is where each over-report is answered once, in writing. The
 * scan has already earned its keep: `console.neon.tech` looked like a
 * documentation link beside `api-docs.neon.tech` and is in fact the live API
 * base, so a hand-written list would have excused a real destination.
 */
export const NOT_A_DESTINATION: readonly NotADestination[] = [
  {
    host: 'api-docs.neon.tech',
    reason:
      'a documentation URL in a comment in `src/control/neon-api.ts`, citing the reference the client was written against and the date it was read. Nothing is sent to it. Its live sibling `console.neon.tech` IS a destination and has its own entry.',
  },
  {
    host: 'api.openai.com',
    reason:
      'the OpenAI base URL in `PROVIDER_DIRECT_BASES` (`src/ai/gateway.ts`), which is a table of direct endpoints per provider id rather than a route. **No shipped routing profile names the `openai` provider any more** — the embedding seat, the last one that did, moved onto Cloudflare — so nothing resolves this base and nothing is sent to it. It is deliberately not deleted with the register entry it lost: the provider id is still in `PROVIDER_IDS`, so an operator profile could name it, and a base table with a hole in it would send that operator to a `no direct endpoint configured` error rather than to OpenAI. The moment a shipped profile routes `openai` again, `providersReachable()` reports it, `findRegisterGaps` goes red for a provider no entry claims, and this excuse has to be replaced by an entry — which is the direction R10 needs this to fail in.',
  },
  {
    host: 'gmail.googleapis.com',
    reason:
      "Google's Gmail API, named in `PROVIDER_API_BASE` (`src/ingest/pipedream/client.ts`) and cited in `src/ingest/pipedream/sources/gmail.ts`. **This fleet opens no connection to it.** The connector proxy takes the whole upstream URL as a base64url path segment, so the string is a *forwarding instruction handed to Pipedream*, which makes the call under the OAuth grant it holds; every byte brainz sends still goes to `api.pipedream.com`. The party that reads a tenant's mailbox on our behalf is therefore the `pipedream` entry, which says so and holds the token. It appeared here as a host the moment the proxy shape was corrected to name its upstream — before that the same call was made with an app-relative path and no hostname in the source at all, which is precisely the invisibility this scan exists to remove: the destination did not change, only whether the code said it out loud.",
  },
  {
    host: 'people.googleapis.com',
    reason:
      "Google's People API — the address book behind the `contacts` connector — named in `PROVIDER_API_BASE` (`src/ingest/pipedream/client.ts`) and cited in `src/ingest/pipedream/sources/contacts.ts`. Nothing is sent to it directly, for the reason the two Google entries above give: it is the forwarding target inside a Pipedream proxy call, so every byte this fleet sends still goes to `api.pipedream.com`, which holds the OAuth grant and makes the call. It is spelled out rather than assumed because it is not interchangeable and that was **measured, not reasoned about**: the same path under `www.googleapis.com` answers 400, which is the opposite way round from Calendar, whose own entry records that it answers 200 on `www.` and 404 on its own host. This is also the entry to read before assuming the contacts lane is a data flow like the other three — it asks for `names,emailAddresses,organizations,metadata` and deliberately not `biographies`, `addresses`, `birthdays` or `urls`, which is asking Google for less of a third party's personal data than the connection actually permits.",
  },
  {
    host: 'www.googleapis.com',
    reason:
      "Google's Calendar and Drive APIs, named once in `PROVIDER_API_BASE` (`src/ingest/pipedream/client.ts`) and cited in `src/ingest/pipedream/sources/calendar.ts` and `sources/drive.ts`. Nothing is sent to it directly, for the same reason as `gmail.googleapis.com` directly above — it is the forwarding target inside a Pipedream proxy call, not a destination this fleet addresses. The host is spelled out rather than assumed because it is not interchangeable: the same Calendar path under `calendar.googleapis.com` answers Google's own 404, which would reach the runner as an empty calendar rather than as a mistake.",
  },
  {
    host: 'developers.openai.com',
    reason:
      "a documentation URL in comments in `src/mcp/openai.ts` and `src/ingest/oauth/seam.ts`, citing the `search`/`fetch` contract the `/openai` surface was built against and the date it was read (2026-08-15). Nothing is sent to it, and it is deliberately not deleted from the comment: the citation is the receipt for a shape this repository is conformant to. Its live sibling `api.openai.com` is a base URL no shipped profile routes to any more, and is excused directly above.",
  },
];

export const SHARED_COMPONENTS: readonly RegisterEntry[] = [
  {
    id: 'cloudflare',
    name: 'Cloudflare (Workers, Containers, model billing)',
    kind: 'substrate',
    shared_by: 'all_tenants',
    transmits_user_content: true,
    blast_radius:
      'Total, and wider than it was. Cloudflare hosts the MCP fleet and the worker fleet as containers, terminates every request, and holds the compute that holds every tenant’s decrypted working set. It is now also the billing and transport path for eight of the nine model ops on the hosted profile: five open-weight models it runs itself, and — this is the part a reader should not have to infer — the three third-party ops it passes through to Google under its own provider relationship. So the text of every document run through extraction, enrichment or contradiction detection now transits Cloudflare in addition to reaching Google. It is the broadest single component in the system, and it is listed rather than treated as invisible substrate precisely because it is the one a reader is most likely to forget to count.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'The account API token is rotated through the Cloudflare dashboard and re-put into the deployment secret store; the platform account itself cannot be rotated, only migrated, which is what makes it the entry with no mitigation beside it. The same token now also pays for model inference, so rotating it stops every model op on the hosted profile except embedding.',
    evidence: {
      hosts: ['api.cloudflare.com', 'gateway.ai.cloudflare.com'],
      bindings: ['brainz-fleet'],
    },
  },
  {
    id: 'mcp-fleet',
    name: 'MCP fleet (`/mcp`, `/openai`)',
    kind: 'fleet',
    shared_by: 'all_tenants',
    transmits_user_content: true,
    blast_radius:
      'Every tenant served by the instance. One process serves many tenants under Durable-Object affinity, so a fleet compromise reaches every warm tenant’s connection string and bearer through the secret store’s request-path identity. It is the process that parses attacker-controlled mail, which is why the attestation signing key is deliberately not reachable from it.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'Replaced by deploy. The credentials it *reads* — per-tenant connection strings and bearers — rotate independently through `src/control/secrets.ts`, whose write half the fleet does not hold.',
    evidence: { bindings: ['MCP_FLEET', 'McpFleet'] },
  },
  {
    id: 'worker-fleet',
    name: 'Worker fleet (typed job runner)',
    kind: 'fleet',
    shared_by: 'all_tenants',
    transmits_user_content: true,
    blast_radius:
      'Every tenant with queued work. It runs consolidation, embedding backfill and connector pulls, so it holds tenant content and tenant provider tokens for the duration of a job, and it holds a lease on the control plane.',
    rotation_owner: 'control-plane operator on call',
    rotation: 'Replaced by deploy; leases expire on their own TTL, so a stale worker stops rather than persists.',
    evidence: { bindings: ['WORKER_FLEET', 'WorkerFleet'] },
  },
  {
    id: 'neon-platform',
    name: 'Neon (per-tenant Postgres project) + the org API key',
    kind: 'vendor',
    shared_by: 'all_tenants',
    transmits_user_content: true,
    blast_radius:
      'Total, and this is the credential R9’s structural claim rests on. Every tenant is one Neon project with one branch, one database and one role, which is what makes isolation checkable from a connection string — but the *org* API key creates and deletes projects across the whole account, so its holder reaches every tenant’s database and can delete any of them. The per-tenant connection strings are a different and much narrower thing, held in the secret store.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'Rotated in the Neon console and re-put into the control plane’s secret store. Revocation is immediate on the Neon side; nothing caches it on the request path, because the request path never holds it.',
    evidence: { hosts: ['console.neon.tech'] },
  },
  {
    id: 'object-storage-parent-credential',
    name: 'Object storage (R2) — the parent credential',
    kind: 'platform-credential',
    shared_by: 'all_tenants',
    transmits_user_content: true,
    blast_radius:
      'Every tenant’s raw payloads. R9 settled the boundary as platform-enforced **conditional on correct prefix derivation**: the request path holds only a short-TTL prefix-scoped credential minted from this one, and a scoped credential met an attributable 403 on every cross-tenant read, write, delete and list. That reduction is real only if the parent is not resolvable by the request-path identity — the same rule R11 applies to connection strings, applied to a second store. The parent lives inside a `ScopedCredentialMinter` closure and the accessor exposes only methods.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'Rotated in the R2 dashboard and re-put into the control plane’s store. Already-minted child credentials stay valid until their own short TTL lapses; `invalidate` drops this process’s cache and honestly cannot recall a credential already handed out.',
    evidence: {},
    note:
      'No host literal: the S3 endpoint is derived from the account id at run time rather than written into a source file, so this entry is not covered by the host sweep. It is named here because the credential exists, not because a scanner found it.',
  },
  {
    id: 'attestation-signing-key',
    name: 'Attestation signing key',
    kind: 'platform-credential',
    shared_by: 'all_tenants',
    transmits_user_content: false,
    blast_radius:
      'Whoever can sign can forge an isolation receipt for **any** tenant. That is the whole of it, and it is why custody rather than naming is the control: a receipt signed by a key the MCP fleet can read proves nothing an attacker who owns the fleet could not forge, and the fleet is the process that parses attacker-controlled mail. A single compromise would then yield both the isolation failure and valid receipts attesting it had not happened.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'CUSTODY: the private key is held outside the MCP fleet’s readable secret scope — a KMS key the fleet holds `Sign` on and no export permission for, or a sign-only signer endpoint bound to the fixed attestation payload shape. It is never placed in `src/control/secrets.ts`, which is the store the request path CAN read; `test/mcp/attestation.test.ts` pins that store’s two-field shape so putting it there is a red test. ROTATION: publish the new verification key beside the old one, start signing with the new key id, and keep the old key id verifiable for one attestation-cache lifetime, then retire it. REVOCATION: remove the key id from the published verification list — every receipt bearing it stops verifying immediately, which is the intended blast radius of a suspected compromise. STATUS: no real key exists. What ships is `createInProcessSigner`, an HMAC key in a closure that proves the code offers no export path and cannot prove a deployed container is denied one. VERIFICATION KEY: none published yet; a real asymmetric signer publishes its public key here and the canary probe checks receipts against it.',
    evidence: {},
  },
  {
    id: 'tenant-secret-store',
    name: 'Tenant secret store (connection strings + bearers)',
    kind: 'platform-credential',
    shared_by: 'all_tenants',
    transmits_user_content: false,
    blast_radius:
      'Every tenant’s database and every tenant’s bearer, if resolved without scope. R11 is decided here rather than at the tool surface: resolution bypasses tool dispatch entirely, so entries are namespaced per tenant and resolvable only by the fleet request-path identity serving that tenant’s own authenticated bearer. The `/admin` and web-app identities hold no resolve permission on any tenant namespace — a `scope_denied` on `recall` proves nothing if the same credential can read the connection string and connect directly.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'A `put` through `src/control/secrets.ts`, which invalidates the cached entry in the same operation. A rotation performed out of band is bounded by the cache TTL.',
    evidence: {},
  },
  {
    id: 'billing-webhook-secret',
    name: 'Billing webhook endpoint signing secret (Stripe)',
    kind: 'platform-credential',
    shared_by: 'all_tenants',
    transmits_user_content: false,
    blast_radius:
      'Paid capability on every tenant. This secret is the only thing standing between an arbitrary POST and `src/control/billing.ts`, which is the only module allowed to move `control.tenant.tier` — and the tier is what decides whether the consolidation cycle runs its model phases. Whoever holds it can forge an upgrade for any customer (granting themselves metered model spend on our account) or forge a downgrade for any customer (silently stopping their consolidation). It reads no user content and can write no row outside the subscription and tier columns, which is why the radius is capability rather than data.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'Rotated at the vendor, which serves both the old and the new secret during the overlap; the verifier accepts any matching `v1` in the header for exactly that reason, so a rotation needs no coordinated deploy. Injected at construction from the secret store and never read from a request — an empty secret refuses every delivery rather than verifying a deterministic HMAC an attacker could compute.',
    evidence: {},
  },
  {
    id: 'identity-store',
    name: 'Identity and billing database (accounts, sessions, subscriptions)',
    kind: 'platform-credential',
    shared_by: 'all_tenants',
    transmits_user_content: false,
    blast_radius:
      'Every account’s email address, and the ability to mint a session for any of them. It is a separate database from the control plane on purpose — `src/control/schema.sql` says identity lives in U15’s own store, and the control plane’s content-free claim reads better when it is literally true of the database the register names. It holds no brain content, no plaintext password (argon2id only) and no usable session or reset token (SHA-256 digests only), so a copy of it contains nothing anyone can sign in with; what it does contain is the user list, which is why it carries its own entry rather than being folded into the web app’s.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'Database role credential rotated at the provider and re-put into the secret store. Compromise is answered by rotating the role and revoking every session (`account.session` is a delete), which signs every user out rather than trusting a bounded TTL.',
    evidence: {},
  },
  {
    id: 'pool-secret-namespace',
    name: 'Warm-pool connection strings (`pool/` namespace)',
    kind: 'platform-credential',
    shared_by: 'no_tenant_data',
    transmits_user_content: false,
    blast_radius:
      'Every unclaimed Neon project in the warm pool — databases that have been created and handed to nobody, so they hold no user’s data and no user’s schema. The reason it is a register entry rather than a footnote is that it is the one place the control-plane identity may *resolve* a secret at all: `src/control/secrets.ts` gives it a separate predicate on a separate `pool/` prefix, so the widening is exactly one namespace wide and provisioning still cannot read any tenant entry. The moment a project is claimed its string is rewritten under the tenant’s own namespace and the pool entry is revoked, which is where this credential class stops applying to it.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'Not rotated — retired. A suspect pool project is moved to `retired` and a fresh one filled; there is no user to migrate, which is the whole advantage of a credential that only ever addresses unclaimed resources.',
    evidence: {},
  },
  {
    id: 'pipedream',
    name: 'Pipedream (connector substrate) + the project key',
    kind: 'vendor',
    shared_by: 'some_tenants',
    transmits_user_content: true,
    blast_radius:
      'Every tenant who has connected a source. Pipedream holds live OAuth tokens to those users’ mailboxes, calendars and drives, and the project key addresses every external user in the project — so it is inside the trust boundary in the strongest sense: an account erasure that does not delete the Pipedream external user leaves live tokens to an erased user’s mailbox at a vendor.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'Rotated in the Pipedream dashboard and re-put into the control plane’s store. **Two fleets hold the project key** — the web app mints connect links and reconciles authorizations on a dashboard render, the worker fleet reconciles on its tick and polls — so a rotation has to reach both manifests; the MCP fleet holds none of it. Per-user tokens are revoked individually as part of the account-erasure runbook rather than by rotating this key.',
    evidence: { hosts: ['api.pipedream.com', 'pipedream.com'] },
  },
  {
    id: 'stripe',
    name: 'Stripe (subscription billing) — the vendor',
    kind: 'vendor',
    shared_by: 'some_tenants',
    transmits_user_content: false,
    blast_radius:
      'Every tenant who has reached checkout, and only those: Stripe holds their email address, their payment relationship and the customer id `account.subscription` is keyed on, while a free-tier account never becomes a customer at all (`stripe_customer_id` stays null). No brain content is ever sent to it and `account.billing_event` deliberately stores no event payload, which is why this row says no where the other vendors say yes — and it is the one line `docs/legal/privacy-policy.md` makes about a named subprocessor. The credential that lets the vendor’s events *do* anything here is a separate blast radius with a separate entry, `billing-webhook-secret`; this entry is the party, not the key.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'Nothing brainz holds addresses Stripe today: there is no SDK, no API key and no outbound call in `src/`, so the only credential in this relationship is the endpoint signing secret, rotated under its own entry. The vendor account itself is migrated rather than rotated, the way the Cloudflare entry says of its own. Building the checkout and portal legs U15 reported `deferred` adds a secret API key to this relationship, and that is a change to this entry rather than a config edit.',
    evidence: {},
    note:
      'No host, no provider and no binding: the contact is an inbound webhook verified by HMAC, so none of the three completeness sweeps can find this entry and none of them would go red if it were deleted. It is named because R10 asks for every party user data reaches and `docs/legal/subprocessors.md` publishes Stripe as one — a subprocessor the register does not name is the mismatch R10 exists to prevent, in the direction nothing scans for. `test/register/completeness.test.ts` holds this row and `billing-webhook-secret` in place, and says in as many words what that assertion can and cannot establish.',
  },
  {
    id: 'google',
    name: 'Google — extraction, enrichment, contradiction detection',
    kind: 'model-provider',
    shared_by: 'all_tenants',
    transmits_user_content: true,
    blast_radius:
      'The text of every document run through extraction or enrichment, for every tenant. Still one of KTD13’s two model-side processors, but reached two different ways: on the hosted profile the call goes to Google THROUGH Cloudflare’s billing endpoint, so both parties see the content and the platform holds no Google credential at all; on the self-host profile it goes to Google directly with the operator’s own key. The processor is the same either way, which is why this entry did not go away when the route changed.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'On the self-host profile, rotated in the Google Cloud console and re-put into the control plane’s store. On the hosted profile there is nothing here to rotate: Cloudflare holds the provider relationship, and rotating the Cloudflare token is what cuts this path off.',
    evidence: { hosts: ['generativelanguage.googleapis.com'], providers: ['google'] },
    note:
      'Read the evidence on this row narrowly: **both halves of it come from the self-host profile, and neither can see the hosted one.** Since the seats moved, the hosted route to Google records `provider: cloudflare` and calls a Cloudflare hostname — the serving lab is encoded in the model id (`google/gemini-3.5-flash-lite`) and appears in none of the three completeness sweeps. So this entry is held in place by the self-hosted deployment reaching Google directly, not by the hosted plane that actually sends the most content there. Withdraw the self-host profile and the check does not fall silent: it reports this entry as stale and invites its deletion, while every extracted document keeps crossing to Google through the passthrough. It is named by hand for the same reason `stripe` is, and `upstream/concepts.jsonl:gap.register-passthrough-vendor-blindness` carries the fourth evidence set that would make the sweep see it.',
  },
  {
    id: 'cloudflare-models',
    name: 'Cloudflare Workers AI — open-weight inference and the rerank endpoint',
    kind: 'model-provider',
    shared_by: 'all_tenants',
    transmits_user_content: true,
    blast_radius:
      'Every content-touching model op except embedding: briefing composition, salience, the judge, vision, the cross-encoder rerank that scores a query against candidate passages, and — since the seats moved — extraction, enrichment and contradiction detection, which are Google’s model passed through rather than an open-weight one. For the open-weight ops it is not a third lab (these are open weights on Cloudflare GPUs with no proxy to the originating lab) and it adds no subprocessor beyond the Cloudflare entry it belongs to; for the passed-through ops the originating lab IS a subprocessor and keeps its own entry above. It is listed separately anyway, because "the rerank endpoint" is a component a reader will look for by name.',
    rotation_owner: 'control-plane operator on call',
    rotation: 'Covered by the Cloudflare account token rotation above; there is no separate credential.',
    evidence: { providers: ['cloudflare'] },
  },
  {
    id: 'self-host-inference',
    name: 'Self-hosted inference endpoint',
    kind: 'model-provider',
    shared_by: 'no_tenant_data',
    transmits_user_content: false,
    blast_radius:
      'None in the hosted product. The `self-host` profile is the open-source deployment’s route: the same open weights behind an operator’s own endpoint, reachable only by an operator who configured one. It carries no default base URL, which is why the host sweep finds none. It is named because a routing profile can reach it, and a reachable model destination that nobody named is exactly what the completeness check exists to refuse.',
    rotation_owner: 'the self-hosting operator',
    rotation: 'The operator’s own; brainz holds no credential for it.',
    evidence: { providers: ['self-host'] },
  },
  {
    id: 'web-app',
    name: 'Web app and control plane (`/signup`, `/dashboard`, `/admin`)',
    kind: 'web-app',
    shared_by: 'all_tenants',
    transmits_user_content: false,
    blast_radius:
      'Every tenant’s account row, tier, spend counter and connection metadata, plus — now that it is a deployed container rather than a process nobody started — the identity database’s credential, the billing vendor’s key and the substrate vendor’s organisation key, none of which any other fleet holds. Deliberately NOT every tenant’s content: the control-plane database is content-free by rule and by test, and the `/admin` credential has zero content-read scope — asserted by a CI case expecting `scope_denied` on `recall`, and, one layer down, by holding no resolve permission on any tenant secret namespace. **The control plane holds one further class, sealed rather than absent, and it is worth naming rather than folding into “metadata”:** each connected source’s `ConnectorState` (`control.connector_link`) carries the provider’s own sync cursor and the mailbox the provider names, in an AES-256-GCM envelope bound to `connector/<tenant>/<source>` — the same treatment, under the same key, as the tenant connection strings the secret store keeps here. So a dump of this database yields ciphertext for that class too, and the rule it satisfies is the generalised one: the control plane holds nothing a reader of the control plane can use.',
    rotation_owner: 'control-plane operator on call',
    rotation:
      'Replaced by deploy, like the other two fleets. Session secrets rotate with it; the `/admin` credential is rotated through the control plane, and the vendor keys through their vendors.',
    evidence: { hosts: ['app.brainz.test'], bindings: ['WEB_FLEET', 'WebFleet'] },
    note: 'It answers on the SAME public origin as the MCP surface, path-routed by the Worker, because a session cookie is scoped to an origin and the consent screen has to read the one the login page wrote. The host in source is the test origin; the deployed origin is set per environment.',
  },
  {
    id: 'claude-client',
    name: 'Claude (the connecting client)',
    kind: 'client',
    shared_by: 'some_tenants',
    transmits_user_content: true,
    blast_radius:
      'Whatever a tenant’s own assistant reads. It is named because R10 asks for every party user content is transmitted TO, and a connected client is one — the answers to `recall`, `search` and `briefing` leave the trust boundary into the client’s context on every call. It reaches one tenant per grant and cannot address another; the OAuth grant it holds is endpoint-bound and revocable.',
    rotation_owner: 'the tenant',
    rotation:
      'The tenant disconnects the connector, or the grant is revoked through the authorization store — a self-contained token cannot be withdrawn by rewriting it, so revocation is a list consulted on every call.',
    evidence: { hosts: ['claude.ai'] },
  },
];
