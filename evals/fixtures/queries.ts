/**
 * Seventy-seven evaluation queries, their gold keys, and their answerability audits.
 *
 * **Why the audit lives on the query record.** R6a's upper bound needs a
 * hand-audited answerability sample per question type: a statement, checkable by
 * a reader, that the answer really is reachable from this corpus by the stack
 * that will be graded on it. Keeping that statement next to the gold key it
 * justifies is what makes the loader able to check it mechanically — every
 * `mechanisms` entry is resolved against `upstream/concepts.jsonl`, and every id
 * must belong to a unit that lands by U5. A query whose evidence chain needs the
 * cross-encoder (U12) or the compiled-truth boost (U11) would be unanswerable by
 * the stack U5 ships, and a floor miss on such a query would be misread as an
 * architecture failure. That is precisely the misreading R6a exists to prevent,
 * so it is a load error rather than a review note.
 *
 * The audit is 100% rather than a sample. R6a asks for a sample; the corpus is
 * small enough that auditing all of it costs little, and a sample leaves the
 * unaudited remainder as exactly the place a broken gold key hides.
 *
 * **Two axes, independently assigned.** `type` is R6's question type and every
 * query has exactly one. `family` is the probe family — title-substring, alias,
 * dilution, or general — and every query has exactly one of those too. They are
 * orthogonal: an alias probe is usually also a named-entity question, and the
 * two floors fail for different reasons.
 *
 * **Grants are the fence, expressed as a query input.** A query is asked by a
 * credential, and `grant` is what that credential may see. Six queries appear
 * twice with the same text and different grants and different correct answers —
 * a stack that ignores the grant gets exactly one of each pair wrong, and a
 * stack that reaches across it is not scored at all, it is a violation.
 *
 * **Where the dilution queries repeat themselves, they say so.** Ten dilution
 * queries are drawn from five duplicate clusters at two phrasings each. That is
 * deliberate — the clusters are what is being probed, and two phrasings over one
 * cluster is a weaker signal than two clusters would be. It is recorded here
 * rather than left for a reader to discover from the ids.
 */

import type { FixtureQuery, OriginContext } from './types.ts';

/** The personal credential's reach. */
const PERSONAL: readonly OriginContext[] = [
  'personal:mail',
  'personal:chat',
  'personal:files',
  'personal:calendar',
];

/** The work credential's reach. */
const WORK: readonly OriginContext[] = ['work:mail', 'work:files', 'work:calendar'];

/** Both grants held at once — the ordinary state of a brain with two mailboxes. */
const BOTH: readonly OriginContext[] = [...PERSONAL, ...WORK];

export const QUERIES: readonly FixtureQuery[] = [
  // =========================================================================
  // Title-substring probes (20). Each is a substring of a real page title, and
  // each has a body-text decoy that repeats those words more densely than the
  // titled page does. Only a page-title signal separates them.
  // =========================================================================
  {
    id: 'q-ts-01-saltmarsh-retro',
    text: 'Saltmarsh launch retro',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-saltmarsh-retro#0'],
    supporting: { 'p-saltmarsh-retro#1': 2, 'p-saltmarsh-retro#2': 2, 'p-saltmarsh-charter#0': 1 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm', 'stack.rrf-fusion'],
    evidence:
      'The retro document is titled exactly this and its opening chunk carries the outcome. The standup chat asks for the same document by name three times in one line, so term overlap alone answers with the chat.',
  },
  {
    id: 'q-ts-02-windbreak-status',
    text: 'Windbreak status update',
    type: 'named_entity',
    family: 'title_substring',
    grant: WORK,
    answers: ['p-windbreak-status#0'],
    supporting: { 'p-windbreak-status#1': 2, 'p-windbreak-status#2': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The status document is titled this and opens with the pilot state. The work-grant decoy ("Notes to self") repeats the phrase four times in one chunk.',
  },
  {
    id: 'q-ts-03-halcyon-renewal-terms',
    text: 'Halcyon Grid renewal terms',
    type: 'temporal',
    family: 'title_substring',
    grant: WORK,
    answers: ['p-halcyon-renewal-2026#0'],
    supporting: { 'p-halcyon-renewal-2026#1': 2, 'p-halcyon-renewal-2025#0': 1 },
    mechanisms: ['stack.title-phrase-boost', 'stack.recency-decay', 'stack.rrf-fusion'],
    evidence:
      'Two pages carry this title — the 2026 one and the 2025 one — so the title signal alone is a tie, and the 2025 page says "renewal price" four times to the 2026 page\'s once. Recency breaks it. The 2026 fact supersedes the 2025 fact, which is the same judgement stated in the fact table.',
  },
  {
    id: 'q-ts-04-kettle-supplier-list',
    text: 'Kettle and Quill supplier list',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-kettle-supplier-list#0'],
    supporting: { 'p-kettle-supplier-list#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The list is titled this and its first chunk names the suppliers. The standup chat asks for it by name twice in one line.',
  },
  {
    id: 'q-ts-05-verdant-overview',
    text: 'Verdant Loom company overview',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-verdant-overview#0'],
    supporting: { 'p-verdant-overview#1': 2, 'p-verdant-overview#2': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The overview is titled this. The standup chat line repeats "verdant loom company overview" three ways.',
  },
  {
    id: 'q-ts-06-tessellate-memo',
    text: 'Tessellate Capital Series A memo',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-tessellate-memo#0'],
    supporting: { 'p-tessellate-memo#1': 2, 'p-tessellate-memo#2': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The memo is titled this and opens with what Tessellate did. The second chat firehose asks for it by name three times.',
  },
  {
    id: 'q-ts-07-kettle-relocation',
    text: 'Kettle and Quill relocation note',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-kettle-move#0'],
    supporting: { 'p-kettle-move#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The note is titled this and its first chunk carries the move. The second chat firehose repeats the title three ways.',
  },
  {
    id: 'q-ts-08-firmware-hotfix',
    text: 'Firmware 3.4.1 hotfix',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-firmware-fix#0'],
    supporting: { 'p-firmware-fix#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm', 'stack.read-time-dedup'],
    evidence:
      'The hotfix note is titled this. Competing for the same words: the chat firehose line, three copies of the 3.4 advisory, and a quarantined phishing mail that is denser than any of them and must never be returned at all.',
  },
  {
    id: 'q-ts-09-leadership-change',
    text: 'Engineering leadership change',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-sam-promotion#0'],
    supporting: { 'p-sam-promotion#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The promotion mail is titled this and its first chunk carries the change. The second chat firehose repeats the title three ways.',
  },
  {
    id: 'q-ts-10-brackish-followon',
    text: 'Brackish Labs follow-on',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-tessellate-brackish#0'],
    supporting: { 'p-tessellate-brackish#1': 2, 'p-brackish-profile#0': 1 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The follow-on note is titled this. The second chat firehose asks for it by name three times, and a separate background page competes on the company name.',
  },
  {
    id: 'q-ts-11-dana-who-she-is',
    text: 'Dana Ilves who she is',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-dana-profile#0'],
    supporting: { 'p-dana-profile#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The profile note is titled this and characterises her in one sentence. The third chat firehose repeats the title three ways.',
  },
  {
    id: 'q-ts-12-membership-renewal',
    text: 'Membership renewal',
    type: 'context_fenced',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-gym-renewal#0'],
    supporting: { 'p-gym-renewal#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The gym mail is titled this and carries the price. Under this grant the work renewal pages are out of reach entirely; the in-grant competition is the third chat firehose, which repeats "membership renewal" four times.',
  },
  {
    id: 'q-ts-13-quarterly-attendees',
    text: 'Quarterly review attendees',
    type: 'named_entity',
    family: 'title_substring',
    grant: WORK,
    answers: ['p-northwind-invite-list#0'],
    supporting: { 'p-northwind-invite-list#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The invite is titled this and lists the attendees. The work-mail digest repeats the phrase four times in one chunk.',
  },
  {
    id: 'q-ts-14-northwind-vendor-list',
    text: 'Northwind vendor list',
    type: 'context_fenced',
    family: 'title_substring',
    grant: WORK,
    answers: ['p-northwind-vendor-list#0'],
    supporting: { 'p-northwind-vendor-list#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The vendor list is titled this. Its personal-grant twin (the Kettle and Quill supplier list) is out of reach here, and the in-grant decoy is the work notes file, which repeats the phrase four times.',
  },
  {
    id: 'q-ts-15-priya-introduction',
    text: 'Priya Raghunathan introduction',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-priya-intro#0'],
    supporting: { 'p-priya-intro#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The introduction mail is titled this. The third chat firehose repeats the title three ways.',
  },
  {
    id: 'q-ts-16-saltmarsh-charter',
    text: 'Project Saltmarsh charter',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-saltmarsh-charter#0'],
    supporting: { 'p-saltmarsh-charter#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The charter is titled this and its first chunk states the scope and the owner. The fourth chat firehose repeats the title four ways.',
  },
  {
    id: 'q-ts-17-northwind-background',
    text: 'Northwind Analytics background',
    type: 'named_entity',
    family: 'title_substring',
    grant: WORK,
    answers: ['p-northwind-profile#0'],
    supporting: { 'p-northwind-profile#1': 2, 'p-northwind-invite-list#0': 1 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The background document is titled this. The work notes file repeats the phrase three times, and the calendar invite says "Northwind Analytics" five times while characterising nothing.',
  },
  {
    id: 'q-ts-18-halcyon-background',
    text: 'Halcyon Grid background',
    type: 'named_entity',
    family: 'title_substring',
    grant: WORK,
    answers: ['p-halcyon-profile#0'],
    supporting: { 'p-halcyon-profile#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The background document is titled this. The work notes file repeats the phrase four times.',
  },
  {
    id: 'q-ts-19-pilot-outcome',
    text: 'Pilot outcome',
    type: 'temporal',
    family: 'title_substring',
    grant: WORK,
    answers: ['p-pilot-outcome#0'],
    mechanisms: ['stack.title-phrase-boost', 'stack.recency-decay', 'stack.keyword-arm'],
    evidence:
      'The outcome note is titled this and postdates the brief by three months. The work notes file repeats "pilot outcome" four times, and two copies of the earlier pilot brief compete on "pilot".',
  },
  {
    id: 'q-ts-20-design-review-notes',
    text: 'Design review notes',
    type: 'named_entity',
    family: 'title_substring',
    grant: PERSONAL,
    answers: ['p-tosh-review#0'],
    supporting: { 'p-tosh-review#1': 2 },
    mechanisms: ['stack.title-phrase-boost', 'stack.keyword-arm'],
    evidence:
      'The notes are titled this. The fourth chat firehose repeats the title four ways in one chunk.',
  },

  // =========================================================================
  // Alias probes (14). Every one collides with a literal lexical match, so a
  // keyword arm answers confidently and wrongly.
  // =========================================================================
  {
    id: 'q-al-01-sam-current-title',
    text: "Sam's current title",
    type: 'temporal',
    family: 'alias',
    grant: PERSONAL,
    answers: ['p-sam-promotion#0'],
    supporting: { 'p-sam-old-title#0': 1, 'p-verdant-overview#2': 1 },
    mechanisms: ['stack.alias-hop', 'stack.recency-decay', 'imp.entity-resolution-ladder'],
    evidence:
      '"Sam" is a user-declared alias for Samantha Okonkwo. Her current title is on the promotion mail; the 2024 introductions mail says "Head of Engineering" three times and is the denser match. No page contains the token "Sam" except the pages about a different person, Sam Trelawney.',
  },
  {
    id: 'q-al-02-who-is-sam',
    text: 'who is Sam',
    type: 'named_entity',
    family: 'alias',
    grant: BOTH,
    answers: ['p-sam-promotion#0'],
    supporting: { 'p-verdant-overview#2': 2, 'p-sam-old-title#0': 1 },
    mechanisms: ['stack.alias-hop', 'imp.entity-resolution-ladder', 'stack.graph-arm'],
    evidence:
      'The user-declared alias resolves to Samantha Okonkwo. Under this grant the corpus also contains Sam Trelawney, named literally three times in one chunk, which is what a keyword arm returns.',
  },
  {
    id: 'q-al-03-where-does-sam-work',
    text: 'where does Sam work',
    type: 'relational',
    family: 'alias',
    grant: BOTH,
    answers: ['p-verdant-overview#2'],
    supporting: { 'p-sam-promotion#0': 2 },
    mechanisms: ['stack.alias-hop', 'stack.graph-arm', 'imp.entity-resolution-ladder'],
    evidence:
      'Alias hop to Samantha Okonkwo, then the works_at edge to Verdant Loom, whose evidence chunk is the overview\'s third paragraph. Sam Trelawney also has a works_at edge, which is why the alias hop has to happen before the graph walk rather than after it.',
  },
  {
    id: 'q-al-04-sam-o-roadmap',
    text: 'Sam O. and the roadmap',
    type: 'named_entity',
    family: 'alias',
    grant: PERSONAL,
    answers: ['p-sam-old-title#0'],
    mechanisms: ['stack.alias-hop', 'stack.keyword-arm'],
    evidence:
      'The only statement about the roadmap in the corpus is on the 2024 introductions mail, and it is attributed to Samantha Okonkwo. "Sam O." is a user-declared alias. This one is deliberately answered by a superseded page: the claim about the roadmap was never superseded, only the title was.',
  },
  {
    id: 'q-al-05-s-okonkwo-verdant',
    text: 'S. Okonkwo Verdant Loom',
    type: 'relational',
    family: 'alias',
    grant: PERSONAL,
    answers: ['p-verdant-overview#2'],
    supporting: { 'p-sam-promotion#0': 2, 'p-verdant-overview#0': 1 },
    mechanisms: ['stack.alias-hop', 'stack.graph-arm', 'imp.entity-resolution-ladder'],
    evidence:
      'An inferred alias at 0.82 confidence, so this probe also exercises the resolution ladder\'s willingness to use a scored alias. The overview page names her alongside the company.',
  },
  {
    id: 'q-al-06-sam-email',
    text: 'sokonkwo@example.com',
    type: 'named_entity',
    family: 'alias',
    grant: BOTH,
    answers: ['p-sam-promotion#0'],
    supporting: { 'p-verdant-overview#2': 2 },
    mechanisms: ['stack.alias-hop', 'stack.shared-normalizer', 'imp.entity-resolution-ladder'],
    evidence:
      'The address is a user-declared alias. The only page containing the literal string is a distribution-list footer that says nothing about anyone, which is exactly what a keyword arm returns. The normalizer matters here because the address must be looked up the way it was stored.',
  },
  {
    id: 'q-al-07-tosh-design-review',
    text: 'Tosh design review',
    type: 'named_entity',
    family: 'alias',
    grant: PERSONAL,
    answers: ['p-tosh-review#0'],
    supporting: { 'p-tosh-review#1': 2 },
    mechanisms: ['stack.alias-hop', 'stack.title-phrase-boost'],
    evidence:
      '"Tosh" is a user-declared alias for Toshiro Abe and appears nowhere in the corpus as a token. The design review notes are his; the chat firehose repeats "design review" four times and is the denser match on the only two words a keyword arm can use.',
  },
  {
    id: 'q-al-08-tosh-wants-changed',
    text: 'what does Tosh want changed',
    type: 'named_entity',
    family: 'alias',
    grant: PERSONAL,
    answers: ['p-tosh-review#0'],
    supporting: { 'p-tosh-review#1': 2 },
    mechanisms: ['stack.alias-hop', 'imp.entity-resolution-ladder'],
    evidence:
      'Same alias, different phrasing: with "design review" removed from the query there is no lexical path to the answer at all, so this probe isolates the alias hop from the title boost.',
  },
  {
    id: 'q-al-09-who-is-mv',
    text: 'who is MV',
    type: 'named_entity',
    family: 'alias',
    grant: BOTH,
    answers: ['p-marcus-profile#0'],
    supporting: { 'p-marcus-profile#1': 2 },
    mechanisms: ['stack.alias-hop', 'imp.entity-resolution-ladder'],
    evidence:
      '"MV" is a user-declared alias for Marcus Vandenberg. The corpus also contains a load-test document that says "MV" six times, meaning the rig, which is what term overlap returns.',
  },
  {
    id: 'q-al-10-mv-roast-contract',
    text: 'MV roast contract',
    type: 'relational',
    family: 'alias',
    grant: BOTH,
    answers: ['p-kettle-supplier-list#1'],
    supporting: { 'p-marcus-profile#1': 2, 'p-roast-file#0': 1 },
    mechanisms: ['stack.alias-hop', 'stack.graph-arm', 'stack.corroboration-boost'],
    evidence:
      'Alias hop to Marcus Vandenberg, whose founded edge reaches Kettle and Quill; the supplier list names him as the person who renegotiates the roast contract. Two pages corroborate it. The load-test document again competes on "MV".',
  },
  {
    id: 'q-al-11-marc-shop-location',
    text: "Marc's shop location now",
    type: 'temporal',
    family: 'alias',
    grant: PERSONAL,
    answers: ['p-kettle-move#0'],
    supporting: { 'p-kettle-portland#0': 1, 'p-marcus-profile#0': 1 },
    mechanisms: ['stack.alias-hop', 'stack.recency-decay', 'stack.graph-arm'],
    evidence:
      'Alias hop to Marcus Vandenberg, founded edge to Kettle and Quill, then the current location. The opening-week note says "Portland" five times against the relocation note\'s one "Bristol", and the Portland fact is superseded by the Bristol one.',
  },
  {
    id: 'q-al-12-priya-r-tessellate',
    text: 'Priya R. at Tessellate',
    type: 'relational',
    family: 'alias',
    grant: PERSONAL,
    answers: ['p-priya-intro#0'],
    supporting: { 'p-tessellate-memo#1': 2 },
    mechanisms: ['stack.alias-hop', 'stack.graph-arm'],
    evidence:
      '"Priya R." and "Tessellate" are both user-declared aliases, so this probe needs two hops in one query. The works_at edge carries the answer and the introduction mail is its evidence.',
  },
  {
    id: 'q-al-13-ellie-renewal-price',
    text: 'Ellie renewal price',
    type: 'temporal',
    family: 'alias',
    grant: WORK,
    answers: ['p-halcyon-renewal-2026#0'],
    supporting: { 'p-halcyon-renewal-2026#1': 2, 'p-elena-thread#0': 1 },
    mechanisms: ['stack.alias-hop', 'stack.recency-decay', 'stack.graph-arm'],
    evidence:
      '"Ellie" is a user-declared alias for Elena Barros, who confirmed the 2026 price; her name appears on the 2026 page\'s second chunk. The 2025 page says "renewal price" four times, and a soft-deleted draft says it four more times and must not be returned at all.',
  },
  {
    id: 'q-al-14-kq-suppliers',
    text: 'K&Q suppliers',
    type: 'named_entity',
    family: 'alias',
    grant: PERSONAL,
    answers: ['p-kettle-supplier-list#0'],
    supporting: { 'p-kettle-supplier-list#1': 2, 'p-roast-file#0': 1 },
    mechanisms: ['stack.alias-hop', 'stack.shared-normalizer'],
    evidence:
      '"K&Q" is a user-declared alias for Kettle and Quill and appears nowhere in any page. The normalizer is load-bearing: the ampersand has to survive normalisation the same way on the write and read sides or the alias table is queried in a form it was never populated in.',
  },

  // =========================================================================
  // Dilution probes (10). Five duplicate clusters, two phrasings each. Every
  // one has at least three visible copies of one answer and a second, distinct
  // answer that an un-deduplicated top-3 never reaches.
  // =========================================================================
  {
    id: 'q-di-01-firmware-drain',
    text: 'firmware 3.4 battery drain sensor board',
    type: 'named_entity',
    family: 'dilution',
    grant: BOTH,
    answers: ['p-fwd-advisory-personal#0', 'p-firmware-fix#0'],
    supporting: { 'p-fwd-advisory-work#0': 2, 'p-chat-advisory-paste#0': 2, 'p-firmware-fix#1': 2 },
    requiredGroups: ['dup-advisory', 'dup-firmware-fix'],
    mechanisms: ['stack.read-time-dedup', 'stack.keyword-arm', 'stack.rrf-fusion'],
    evidence:
      'The advisory arrived three times — personal mail, work mail, and a chat paste — with identical wording. The hotfix is a separate page and is the half of the answer that matters. A top-3 of three identical advisories is a complete miss on the second group. A quarantined phishing mail is the densest match of all and must not appear.',
  },
  {
    id: 'q-di-02-firmware-fixed-yet',
    text: 'is the firmware battery drain fixed',
    type: 'temporal',
    family: 'dilution',
    grant: BOTH,
    answers: ['p-firmware-fix#0', 'p-fwd-advisory-personal#0'],
    supporting: { 'p-firmware-fix#1': 2, 'p-fwd-advisory-work#0': 1, 'p-chat-advisory-paste#0': 1 },
    requiredGroups: ['dup-advisory', 'dup-firmware-fix'],
    mechanisms: ['stack.read-time-dedup', 'stack.recency-decay'],
    evidence:
      'Second phrasing of the same cluster. The advisory fact is superseded by the fix fact, so a stack with either dedup or recency reaches the fix; without both, three copies of the superseded advisory fill the list.',
  },
  {
    id: 'q-di-03-invoice-114',
    text: 'invoice 2026-114',
    type: 'named_entity',
    family: 'dilution',
    grant: BOTH,
    answers: ['p-invoice-personal#0', 'p-invoice-paid#0'],
    supporting: { 'p-invoice-work#0': 2, 'p-invoice-chat#0': 2 },
    requiredGroups: ['dup-invoice', 'dup-invoice-paid'],
    mechanisms: ['stack.read-time-dedup', 'stack.keyword-arm'],
    evidence:
      'The invoice exists in personal mail, work mail and a chat paste, each naming the reference twice. The payment confirmation is a separate page and names it once. Term overlap fills the top three with copies of the invoice.',
  },
  {
    id: 'q-di-04-invoice-paid',
    text: 'was invoice 2026-114 paid',
    type: 'temporal',
    family: 'dilution',
    grant: BOTH,
    answers: ['p-invoice-paid#0', 'p-invoice-personal#0'],
    supporting: { 'p-invoice-work#0': 1, 'p-invoice-chat#0': 1 },
    requiredGroups: ['dup-invoice', 'dup-invoice-paid'],
    mechanisms: ['stack.read-time-dedup', 'stack.recency-decay'],
    evidence:
      'Second phrasing. The confirmation postdates the invoice by nineteen days and is the answer; the three copies still dominate on the reference number.',
  },
  {
    id: 'q-di-05-dpa',
    text: 'data processing addendum',
    type: 'named_entity',
    family: 'dilution',
    grant: BOTH,
    answers: ['p-dpa-mail#0', 'p-dpa-status#0'],
    supporting: { 'p-dpa-file#0': 2, 'p-dpa-chat#0': 2 },
    requiredGroups: ['dup-dpa', 'dup-dpa-status'],
    mechanisms: ['stack.read-time-dedup', 'stack.keyword-arm'],
    evidence:
      'The addendum text exists in work mail, work files and a chat quote. The signature status is a separate page. Three identical copies outrank it on every query term.',
  },
  {
    id: 'q-di-06-dpa-signed',
    text: 'has the addendum been signed',
    type: 'temporal',
    family: 'dilution',
    grant: BOTH,
    answers: ['p-dpa-status#0', 'p-dpa-mail#0'],
    supporting: { 'p-dpa-file#0': 1, 'p-dpa-chat#0': 1 },
    requiredGroups: ['dup-dpa', 'dup-dpa-status'],
    mechanisms: ['stack.read-time-dedup', 'stack.recency-decay'],
    evidence:
      'Second phrasing. The signature status postdates the addendum by seven weeks; the copies still carry the word "addendum" once each and tie with it.',
  },
  {
    id: 'q-di-07-roast-contract',
    text: 'roast contract terms',
    type: 'named_entity',
    family: 'dilution',
    grant: PERSONAL,
    answers: ['p-roast-file#0', 'p-roast-price#0'],
    supporting: { 'p-roast-mail#0': 2, 'p-roast-chat#0': 2, 'p-kettle-supplier-list#1': 1 },
    requiredGroups: ['dup-roast', 'dup-roast-price'],
    mechanisms: ['stack.read-time-dedup', 'stack.keyword-arm'],
    evidence:
      'The contract text is in a file, a forwarded mail and a chat quote. The price change is a separate page and is the live half of the answer.',
  },
  {
    id: 'q-di-08-house-blend-price',
    text: 'house blend price now',
    type: 'temporal',
    family: 'dilution',
    grant: PERSONAL,
    answers: ['p-roast-price#0', 'p-roast-file#0'],
    supporting: { 'p-roast-mail#0': 1, 'p-roast-chat#0': 1 },
    requiredGroups: ['dup-roast', 'dup-roast-price'],
    mechanisms: ['stack.read-time-dedup', 'stack.recency-decay'],
    evidence:
      'Second phrasing. All three contract copies contain "house blend"; only the price-change page contains a price, and it is four months newer.',
  },
  {
    id: 'q-di-09-pilot-brief',
    text: 'Windbreak pilot brief',
    type: 'named_entity',
    family: 'dilution',
    grant: BOTH,
    answers: ['p-pilot-brief-file#0', 'p-pilot-outcome#0'],
    supporting: { 'p-pilot-brief-mail#0': 2, 'p-pilot-brief-chat#0': 2 },
    requiredGroups: ['dup-pilot', 'dup-pilot-outcome'],
    mechanisms: ['stack.read-time-dedup', 'stack.title-phrase-boost'],
    evidence:
      'The brief exists in work files, work mail and a chat paste, all titled almost identically. The outcome is the separate page a reader actually wants alongside it.',
  },
  {
    id: 'q-di-10-pilot-went',
    text: 'how did the Windbreak pilot go',
    type: 'temporal',
    family: 'dilution',
    grant: BOTH,
    answers: ['p-pilot-outcome#0', 'p-pilot-brief-file#0'],
    supporting: { 'p-pilot-brief-mail#0': 1, 'p-pilot-brief-chat#0': 1 },
    requiredGroups: ['dup-pilot', 'dup-pilot-outcome'],
    mechanisms: ['stack.read-time-dedup', 'stack.recency-decay'],
    evidence:
      'Second phrasing. The outcome is three months newer than the brief; the three brief copies carry "Windbreak pilot" and tie among themselves.',
  },

  // =========================================================================
  // General probes (18): the relational and context-fenced questions that are
  // not also probing one of the three named failure modes.
  // =========================================================================
  {
    id: 'q-ge-01-who-invested-verdant',
    text: 'who invested in Verdant Loom',
    type: 'relational',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-tessellate-memo#0'],
    supporting: { 'p-tessellate-memo#1': 2, 'p-verdant-round-recap#0': 1 },
    mechanisms: ['stack.graph-arm', 'stack.rrf-fusion', 'imp.entity-resolution-ladder'],
    evidence:
      'The invested_in edge from Tessellate Capital to Verdant Loom, evidenced by the memo. The memo never uses the word "invested" — it says "led the round" — while a newsletter uses it eleven times and mentions no company in the brain.',
  },
  {
    id: 'q-ge-02-tessellate-other-bets',
    text: 'who else has Tessellate backed',
    type: 'relational',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-tessellate-brackish#0'],
    supporting: { 'p-tessellate-memo#0': 2, 'p-brackish-profile#0': 1 },
    mechanisms: ['stack.graph-arm', 'stack.alias-hop'],
    evidence:
      'Two invested_in edges leave Tessellate Capital. The word "backed" appears nowhere in the corpus, so there is no lexical path at all; the second cheque is described as "wrote a second cheque".',
  },
  {
    id: 'q-ge-03-who-works-northwind',
    text: 'who works at Northwind Analytics',
    type: 'relational',
    family: 'general',
    grant: BOTH,
    answers: ['p-dana-profile#0'],
    supporting: { 'p-sam-trelawney#0': 2, 'p-northwind-profile#0': 1 },
    mechanisms: ['stack.graph-arm', 'stack.rrf-fusion'],
    evidence:
      'Two works_at edges point at Northwind Analytics. The calendar invite says the company name five times and names nobody\'s role, which is what term overlap returns.',
  },
  {
    id: 'q-ge-04-who-founded-kettle',
    text: 'who founded Kettle and Quill',
    type: 'relational',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-marcus-profile#0'],
    supporting: { 'p-kettle-supplier-list#1': 1 },
    mechanisms: ['stack.graph-arm', 'stack.keyword-arm'],
    evidence:
      'The founded edge, evidenced by the profile note, which states it in as many words.',
  },
  {
    id: 'q-ge-05-who-advises-kettle',
    text: 'who advises Kettle and Quill',
    type: 'relational',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-priya-intro#1'],
    supporting: { 'p-priya-intro#0': 2, 'p-marcus-profile#0': 1 },
    mechanisms: ['stack.graph-arm'],
    evidence:
      'The advises edge from Priya Raghunathan. Its evidence chunk names the company but not her — her name is in the previous chunk — so the answer needs the graph rather than the sentence.',
  },
  {
    id: 'q-ge-06-saltmarsh-part-of',
    text: 'what is Project Saltmarsh part of',
    type: 'relational',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-saltmarsh-charter#0'],
    supporting: { 'p-verdant-overview#0': 1 },
    mechanisms: ['stack.graph-arm', 'stack.title-phrase-boost'],
    evidence: 'The part_of edge to Verdant Loom, stated on the charter.',
  },
  {
    id: 'q-ge-07-sam-collaborator',
    text: 'who does Samantha work with on water data',
    type: 'relational',
    family: 'general',
    grant: BOTH,
    answers: ['p-dana-profile#1'],
    supporting: { 'p-dana-profile#0': 2 },
    mechanisms: ['stack.graph-arm', 'imp.entity-resolution-ladder'],
    evidence:
      'The symmetric collaborates_with edge. Its evidence chunk does not contain the word "Samantha" at all, so only a graph walk reaches it.',
  },
  {
    id: 'q-ge-08-elena-employer',
    text: 'which company employs Elena Barros',
    type: 'relational',
    family: 'general',
    grant: WORK,
    answers: ['p-elena-thread#0'],
    supporting: { 'p-halcyon-renewal-2026#1': 2, 'p-halcyon-profile#0': 1 },
    mechanisms: ['stack.graph-arm', 'stack.rrf-fusion'],
    evidence:
      'The works_at edge to Halcyon Grid, traversed through its declared inverse. Neither the word "employs" nor the company name appears in the evidence chunk, which calls it "the grid account".',
  },
  {
    id: 'q-ge-09-toshiro-employer',
    text: 'where does Toshiro Abe work',
    type: 'relational',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-verdant-overview#2'],
    supporting: { 'p-sam-promotion#1': 1, 'p-tosh-review#0': 1 },
    mechanisms: ['stack.graph-arm', 'stack.keyword-arm'],
    evidence: 'The works_at edge to Verdant Loom, evidenced by the overview.',
  },
  {
    id: 'q-ge-10-series-a-sponsor',
    text: 'who sponsored the Series A internally',
    type: 'relational',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-tessellate-memo#1'],
    supporting: { 'p-priya-intro#0': 2 },
    mechanisms: ['stack.keyword-arm', 'stack.graph-arm', 'stack.corroboration-boost'],
    evidence:
      'Stated on the memo\'s second chunk and corroborated by the introduction mail, which places her at the fund.',
  },
  {
    id: 'q-ge-11-northwind-project',
    text: 'which project does Northwind run',
    type: 'relational',
    family: 'general',
    grant: WORK,
    answers: ['p-windbreak-status#0'],
    supporting: { 'p-northwind-profile#0': 2, 'p-pilot-outcome#0': 1 },
    mechanisms: ['stack.graph-arm', 'stack.rrf-fusion'],
    evidence:
      'The part_of edge from Project Windbreak. The status page never names Northwind Analytics, so the relationship is only in the graph.',
  },
  {
    id: 'q-ge-12-verdant-design-owner',
    text: 'who owns the design at Verdant Loom',
    type: 'relational',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-verdant-overview#2'],
    supporting: { 'p-tosh-review#0': 2, 'p-sam-promotion#1': 1 },
    mechanisms: ['stack.graph-arm', 'stack.corroboration-boost'],
    evidence:
      'The overview states it and the design review notes corroborate it. The chat firehose repeats "design review" four times without naming anyone.',
  },
  {
    id: 'q-ge-13-windbreak-analyst',
    text: 'who joined the Windbreak pilot as an analyst',
    type: 'relational',
    family: 'general',
    grant: WORK,
    answers: ['p-sam-trelawney#0'],
    supporting: { 'p-northwind-invite-list#0': 1 },
    mechanisms: ['stack.keyword-arm', 'stack.graph-arm'],
    evidence:
      'Stated on the rotation mail. Included deliberately as the case where the literal "Sam" IS the right answer, so the alias hop must not fire on a query that never asked for an alias.',
  },
  {
    id: 'q-ge-14-priya-fund',
    text: 'which fund is Priya at',
    type: 'relational',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-priya-intro#0'],
    supporting: { 'p-tessellate-memo#1': 2 },
    mechanisms: ['stack.graph-arm', 'stack.keyword-arm'],
    evidence: 'The works_at edge to Tessellate Capital, stated on the introduction mail.',
  },
  {
    id: 'q-ge-15-compute-vendor',
    text: 'compute vendor',
    type: 'context_fenced',
    family: 'general',
    grant: WORK,
    answers: ['p-northwind-vendor-list#0'],
    supporting: { 'p-halcyon-profile#0': 2, 'p-halcyon-renewal-2026#0': 1 },
    mechanisms: ['stack.keyword-arm', 'stack.source-type-priors', 'stack.graph-arm'],
    evidence:
      'The vendor list names Halcyon Grid for compute. Neither the word "compute" nor "vendor" appears in the personal grant at all, so this probe checks that a fenced query still ranks well inside its own grant rather than merely avoiding the other one.',
  },
  {
    id: 'q-ge-16-roast-negotiator',
    text: 'who negotiates the roast contract',
    type: 'context_fenced',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-kettle-supplier-list#1'],
    supporting: { 'p-marcus-profile#1': 2, 'p-roast-file#0': 1 },
    mechanisms: ['stack.keyword-arm', 'stack.corroboration-boost', 'stack.read-time-dedup'],
    evidence:
      'The supplier list names him; the profile corroborates. Three identical copies of the contract terms compete on "roast contract" and carry no answer.',
  },
  {
    id: 'q-ge-17-sensor-housing',
    text: 'sensor housing change',
    type: 'context_fenced',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-tosh-review#0'],
    supporting: { 'p-tosh-review#1': 2 },
    mechanisms: ['stack.keyword-arm', 'stack.title-phrase-boost'],
    evidence:
      'The design review notes carry the housing change. Three copies of a firmware advisory mention the sensor board and compete on "sensor".',
  },
  {
    id: 'q-ge-18-review-chair',
    text: 'who chairs the quarterly review',
    type: 'context_fenced',
    family: 'general',
    grant: WORK,
    answers: ['p-northwind-invite-list#1'],
    supporting: { 'p-northwind-invite-list#0': 2 },
    mechanisms: ['stack.keyword-arm', 'stack.title-phrase-boost'],
    evidence:
      'The chair is named in the invite\'s second chunk. The work digest repeats "quarterly review attendees" four times and names nobody.',
  },

  // =========================================================================
  // Temporal probes outside the dilution clusters (4). Without these, most of
  // the temporal type would be carried by dilution queries, and the temporal
  // floor would be measuring dedup as much as it measures time.
  // =========================================================================
  {
    id: 'q-tm-01-kettle-based-now',
    text: 'where is Kettle and Quill based now',
    type: 'temporal',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-kettle-move#0'],
    supporting: { 'p-kettle-portland#0': 1, 'p-kettle-move#1': 2 },
    mechanisms: ['stack.recency-decay', 'stack.keyword-arm'],
    evidence:
      'The Portland fact is superseded by the Bristol one. The opening-week note says "Portland" five times across two chunks; the relocation note says "Bristol" once.',
  },
  {
    id: 'q-tm-02-saltmarsh-actual-ship',
    text: 'when did Saltmarsh actually ship',
    type: 'temporal',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-saltmarsh-retro#0'],
    supporting: { 'p-saltmarsh-ship-date-old#0': 1, 'p-saltmarsh-charter#0': 1 },
    mechanisms: ['stack.recency-decay', 'stack.keyword-arm'],
    evidence:
      'The plan of record says the ship date is 7 April and says "ship date" four times; the retro says it shipped on the 9th and says it once. The planned fact is superseded by the actual one.',
  },
  {
    id: 'q-tm-03-renewal-price-changed',
    text: 'did the renewal price change',
    type: 'temporal',
    family: 'general',
    grant: WORK,
    answers: ['p-halcyon-renewal-2026#0'],
    supporting: { 'p-halcyon-renewal-2025#0': 1, 'p-halcyon-renewal-2026#1': 2 },
    mechanisms: ['stack.recency-decay', 'stack.keyword-arm'],
    evidence:
      'Answering "did it change" needs the current figure, which is the newer page. The 2025 page repeats "renewal price" four times and a soft-deleted draft repeats it four more; neither is the answer and the draft must not appear at all.',
  },
  {
    id: 'q-tm-04-sam-still-head-of-eng',
    text: 'is Samantha still Head of Engineering',
    type: 'temporal',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-sam-promotion#0'],
    supporting: { 'p-sam-old-title#0': 1, 'p-sam-old-title#1': 1 },
    mechanisms: ['stack.recency-decay', 'stack.keyword-arm'],
    evidence:
      'The query contains the stale title verbatim, so every lexical signal points at the superseded page — which says "Head of Engineering" three times and "Samantha Okonkwo" four. Only the supersession answers it.',
  },

  // =========================================================================
  // Context-fenced pairs (6, three pairs). Same text, different grant,
  // different correct answer. A stack that ignores the grant gets exactly one
  // of each pair wrong; one that reaches across it is a violation, not a score.
  // =========================================================================
  {
    id: 'q-cf-01a-renewal-price-work',
    text: 'renewal price for 2026',
    type: 'context_fenced',
    family: 'general',
    grant: WORK,
    answers: ['p-halcyon-renewal-2026#0'],
    supporting: { 'p-halcyon-renewal-2026#1': 2, 'p-halcyon-renewal-2025#0': 1 },
    mechanisms: ['stack.recency-decay', 'stack.keyword-arm'],
    evidence:
      'Under the work grant the answer is the compute renewal. Its 2025 predecessor repeats "renewal price" four times, and a soft-deleted draft with a third figure must not surface at all.',
  },
  {
    id: 'q-cf-01b-renewal-price-personal',
    text: 'renewal price for 2026',
    type: 'context_fenced',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-gym-renewal#0'],
    supporting: { 'p-gym-renewal#1': 2 },
    mechanisms: ['stack.keyword-arm', 'stack.title-phrase-boost'],
    evidence:
      'Identical text to its work twin; under the personal grant the only renewal in reach is the gym membership. A stack that ignores the grant answers both halves of this pair the same way and is therefore wrong exactly once.',
  },
  {
    id: 'q-cf-02a-supplier-list-personal',
    text: 'supplier list',
    type: 'context_fenced',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-kettle-supplier-list#0'],
    supporting: { 'p-kettle-supplier-list#1': 2, 'p-roast-file#0': 1 },
    mechanisms: ['stack.keyword-arm', 'stack.title-phrase-boost'],
    evidence:
      'The personal half of the pair. The chat firehose repeats "kettle and quill supplier list" twice in one line and is the denser lexical match.',
  },
  {
    id: 'q-cf-02b-supplier-list-work',
    text: 'supplier list',
    type: 'context_fenced',
    family: 'general',
    grant: WORK,
    answers: ['p-northwind-vendor-list#0'],
    supporting: { 'p-northwind-vendor-list#1': 2 },
    mechanisms: ['stack.keyword-arm', 'stack.title-phrase-boost'],
    evidence:
      'The work half. The approved supplier list is inside the vendor list page; the work notes file repeats "supplier list northwind" and competes.',
  },
  {
    id: 'q-cf-03a-third-september-personal',
    text: 'what is happening on 3 September',
    type: 'context_fenced',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-personal-calendar-dentist#0'],
    supporting: { 'p-personal-calendar-dentist#1': 1 },
    mechanisms: ['stack.keyword-arm', 'stack.source-type-priors'],
    evidence:
      'Two calendar pages in two grants carry the same date. Under the personal grant it is the dentist. The source-type prior matters because a calendar page is the right kind of page for a date question.',
  },
  {
    id: 'q-cf-03b-third-september-work',
    text: 'what is happening on 3 September',
    type: 'context_fenced',
    family: 'general',
    grant: WORK,
    answers: ['p-work-calendar-review#0'],
    supporting: { 'p-work-calendar-review#1': 1 },
    mechanisms: ['stack.keyword-arm', 'stack.source-type-priors'],
    evidence:
      'The work half of the same date. This is the pair that most directly tests the fence as a ranking input rather than as a filter: the two pages are near-identical in shape and differ only in grant.',
  },
  {
    id: 'q-cf-04-compute-account-price',
    text: 'current price for the compute account',
    type: 'context_fenced',
    family: 'general',
    grant: WORK,
    answers: ['p-halcyon-renewal-2026#0'],
    supporting: { 'p-halcyon-profile#0': 2, 'p-halcyon-renewal-2025#0': 1 },
    mechanisms: ['stack.recency-decay', 'stack.graph-arm', 'stack.keyword-arm'],
    evidence:
      'The word "compute" is on the background page, the price is on the renewal page, and the two are joined by the company. The stale 2025 page and the deleted draft both compete on price.',
  },
  {
    id: 'q-cf-05-dentist',
    text: 'the dentist appointment',
    type: 'context_fenced',
    family: 'general',
    grant: PERSONAL,
    answers: ['p-personal-calendar-dentist#0'],
    mechanisms: ['stack.keyword-arm', 'stack.source-type-priors'],
    evidence: 'Only one page in the personal grant mentions a dentist.',
  },
  {
    id: 'q-cf-06-self-assessment',
    text: 'self assessment deadline',
    type: 'context_fenced',
    family: 'general',
    grant: WORK,
    answers: ['p-work-calendar-review#1'],
    supporting: { 'p-work-calendar-review#0': 2 },
    mechanisms: ['stack.keyword-arm', 'stack.source-type-priors'],
    evidence:
      'The deadline is stated relative to the window opening, so the answer chunk needs its sibling for context — which is what the source-type prior and the page grouping are for.',
  },
  {
    id: 'q-cf-07-pilot-end',
    text: 'when did the pilot end',
    type: 'context_fenced',
    family: 'general',
    grant: WORK,
    answers: ['p-pilot-outcome#0'],
    supporting: { 'p-pilot-brief-file#0': 1 },
    mechanisms: ['stack.recency-decay', 'stack.read-time-dedup'],
    evidence:
      'The outcome page is the only one that describes the pilot in the past tense. Two copies of the brief compete on "pilot" and describe it in the future tense.',
  },
  {
    id: 'q-cf-08-addendum-retention',
    text: 'telemetry retention period',
    type: 'context_fenced',
    family: 'general',
    grant: WORK,
    answers: ['p-dpa-mail#0'],
    supporting: { 'p-dpa-file#0': 2, 'p-dpa-status#0': 1 },
    mechanisms: ['stack.keyword-arm', 'stack.read-time-dedup'],
    evidence:
      'Two visible copies of the addendum carry the retention period under this grant; the chat copy is out of reach. Both copies are correct, which is why the gold key grades the second one as supporting rather than as a separate answer.',
  },
];
