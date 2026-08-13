/**
 * The seeded synthetic brain: forty-nine pages, seven people, six organisations,
 * two projects, a typed edge graph, superseded temporal facts, a value
 * contradiction, and five cross-origin duplicate clusters.
 *
 * **Everyone and everything in here is invented.** The repository is public and
 * the corpus is committed, so there is no real person, company, fund, address or
 * credential anywhere in this file, and every email address is on
 * `example.com`. That is a hard rule, not a courtesy: a fixture corpus is the
 * one artifact in a measurement suite that gets read by strangers.
 *
 * **The corpus is authored adversarially, and that is the point.** R6a's lower
 * bound only means something if a naive single-arm ranker genuinely fails here,
 * and a naive ranker fails only if the corpus is built to defeat it. So:
 *
 * - **Title-substring probes** have a body-text decoy that repeats the title's
 *   own words more densely than the titled page does. A chat log asking "is the
 *   saltmarsh launch retro doc up?" beats the actual retro document on term
 *   overlap, every time. Only a page-title signal separates them.
 * - **Alias probes** collide with a literal lexical match. `Sam` is a
 *   user-declared alias for Samantha Okonkwo, and the corpus also contains a
 *   different person actually named Sam Trelawney, mentioned by that name.
 *   Term overlap answers with the wrong Sam. `MV` collides with a load-test rig.
 * - **Temporal probes** put the *stale* answer in the denser page. The 2025
 *   renewal email says "renewal price" four times; the 2026 one says it once.
 *   A ranker with no notion of validity confidently returns last year's number.
 * - **Relational probes** never state the relationship adjacent to the query's
 *   terms. The investor memo says "led the round" and "wrote the cheque", never
 *   "invested"; the page that says "invested" eleven times is a newsletter.
 * - **Dilution probes** have the same content arriving through two or three
 *   credentials, so an un-deduplicated top-3 is three copies of one answer and
 *   the second, distinct half of the answer never appears.
 * - **Context-fenced probes** come in pairs: the same question text under a
 *   personal grant and under a work grant, with different correct answers. A
 *   stack that ignores the grant gets exactly one of each pair wrong, and a
 *   stack that leaks across it is not scored at all — it is a violation.
 *
 * **Two pages are invisible on purpose.** One is soft-deleted (R12) and one is
 * junk-quarantined (U9), and both are written to be strong lexical matches for
 * live queries. Returning either is a visibility violation rather than a low
 * score, because a tombstoned page reaching a user is a different kind of wrong
 * from a badly ranked one.
 */

import type {
  FixtureEdge,
  FixtureEdgeType,
  FixtureEntity,
  FixtureFact,
  FixturePage,
} from './types.ts';

/**
 * The edge vocabulary, declared in involutive pairs.
 *
 * Every inverse is itself declared and points back, which the tenant schema
 * enforces with a deferred constraint trigger. `collaborates_with` is its own
 * inverse and the schema derives `is_symmetric` from exactly that.
 */
export const EDGE_TYPES: readonly FixtureEdgeType[] = [
  { type: 'invested_in', inverse: 'has_investor', description: 'put capital into' },
  { type: 'has_investor', inverse: 'invested_in', description: 'received capital from' },
  { type: 'works_at', inverse: 'employs', description: 'is employed by' },
  { type: 'employs', inverse: 'works_at', description: 'employs' },
  { type: 'founded', inverse: 'founded_by', description: 'started the organisation' },
  { type: 'founded_by', inverse: 'founded', description: 'was started by' },
  { type: 'advises', inverse: 'advised_by', description: 'gives ongoing counsel to' },
  { type: 'advised_by', inverse: 'advises', description: 'takes ongoing counsel from' },
  { type: 'collaborates_with', inverse: 'collaborates_with', description: 'works jointly with' },
  { type: 'part_of', inverse: 'has_part', description: 'is a component of' },
  { type: 'has_part', inverse: 'part_of', description: 'contains' },
];

export const ENTITIES: readonly FixtureEntity[] = [
  {
    id: 'samantha-okonkwo',
    canonicalName: 'Samantha Okonkwo',
    type: 'person',
    origins: ['personal:mail', 'personal:files', 'personal:chat'],
    aliases: [
      // User-declared, which is what makes the gold key defensible against the
      // other Sam in the corpus: the user said who they mean.
      { alias: 'Sam', source: 'user' },
      { alias: 'Sam O.', source: 'user' },
      { alias: 'S. Okonkwo', source: 'inferred', confidence: 0.82 },
      { alias: 'sokonkwo@example.com', source: 'user' },
    ],
  },
  {
    id: 'toshiro-abe',
    canonicalName: 'Toshiro Abe',
    type: 'person',
    origins: ['personal:mail', 'personal:files'],
    aliases: [
      { alias: 'Tosh', source: 'user' },
      { alias: 'tabe@example.com', source: 'user' },
    ],
  },
  {
    id: 'priya-raghunathan',
    canonicalName: 'Priya Raghunathan',
    type: 'person',
    origins: ['personal:mail', 'personal:files'],
    aliases: [
      { alias: 'Priya R.', source: 'user' },
      { alias: 'praghu@example.com', source: 'user' },
    ],
  },
  {
    id: 'marcus-vandenberg',
    canonicalName: 'Marcus Vandenberg',
    type: 'person',
    origins: ['personal:files', 'personal:mail'],
    aliases: [
      { alias: 'Marc', source: 'user' },
      { alias: 'MV', source: 'user' },
      { alias: 'marcus@example.com', source: 'user' },
    ],
  },
  {
    id: 'dana-ilves',
    canonicalName: 'Dana Ilves',
    type: 'person',
    origins: ['work:mail', 'work:files', 'work:calendar', 'personal:files'],
    aliases: [
      { alias: 'Dana I.', source: 'user' },
      { alias: 'dilves@example.com', source: 'user' },
    ],
  },
  {
    id: 'elena-barros',
    canonicalName: 'Elena Barros',
    type: 'person',
    origins: ['work:mail'],
    aliases: [
      { alias: 'Ellie', source: 'user' },
      { alias: 'ebarros@example.com', source: 'user' },
    ],
  },
  {
    // The alias collision, present as a real person rather than as a trick.
    id: 'sam-trelawney',
    canonicalName: 'Sam Trelawney',
    type: 'person',
    origins: ['work:mail', 'work:calendar'],
    aliases: [],
  },
  {
    id: 'verdant-loom',
    canonicalName: 'Verdant Loom',
    type: 'organization',
    origins: ['personal:files', 'personal:mail', 'personal:chat'],
    aliases: [{ alias: 'VL', source: 'inferred', confidence: 0.61 }],
  },
  {
    id: 'tessellate-capital',
    canonicalName: 'Tessellate Capital',
    type: 'organization',
    origins: ['personal:files', 'personal:mail'],
    aliases: [{ alias: 'Tessellate', source: 'user' }],
  },
  {
    id: 'kettle-and-quill',
    canonicalName: 'Kettle and Quill',
    type: 'organization',
    origins: ['personal:files', 'personal:mail'],
    aliases: [{ alias: 'K&Q', source: 'user' }],
  },
  {
    id: 'northwind-analytics',
    canonicalName: 'Northwind Analytics',
    type: 'organization',
    origins: ['work:mail', 'work:files', 'work:calendar'],
    aliases: [{ alias: 'Northwind', source: 'user' }],
  },
  {
    id: 'halcyon-grid',
    canonicalName: 'Halcyon Grid',
    type: 'organization',
    origins: ['work:mail'],
    aliases: [],
  },
  {
    id: 'brackish-labs',
    canonicalName: 'Brackish Labs',
    type: 'organization',
    origins: ['personal:files'],
    aliases: [],
  },
  {
    id: 'project-saltmarsh',
    canonicalName: 'Project Saltmarsh',
    type: 'project',
    origins: ['personal:files', 'personal:chat'],
    aliases: [{ alias: 'Saltmarsh', source: 'user' }],
  },
  {
    id: 'project-windbreak',
    canonicalName: 'Project Windbreak',
    type: 'project',
    origins: ['work:files', 'work:mail', 'personal:chat'],
    aliases: [{ alias: 'Windbreak', source: 'user' }],
  },
];

export const PAGES: readonly FixturePage[] = [
  // ---------------------------------------------------------------------------
  // Verdant Loom, Tessellate, and the relational spine.
  // ---------------------------------------------------------------------------
  {
    id: 'p-verdant-overview',
    title: 'Verdant Loom company overview',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2025-11-03',
    paragraphs: [
      'Verdant Loom company overview. Verdant Loom builds soil moisture sensors for small vineyards.',
      'Verdant Loom sells the sensors on subscription with a hardware deposit. Verdant Loom has eleven staff, most of them in Lisbon.',
      'Samantha Okonkwo runs engineering at Verdant Loom. Toshiro Abe owns the industrial design and the phone app.',
    ],
  },
  {
    id: 'p-tessellate-memo',
    title: 'Tessellate Capital Series A memo',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2026-01-22',
    paragraphs: [
      'Tessellate Capital Series A memo. Tessellate led the Verdant Loom round and took a board observer seat.',
      'The cheque was 4.2 million euro at a 19 million pre-money. Priya Raghunathan sponsored it internally.',
      'Diligence flagged one concern: hardware gross margin stays thin until unit volume triples.',
    ],
  },
  {
    id: 'p-verdant-round-recap',
    title: 'Round recap for the team',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2026-01-28',
    paragraphs: [
      // The contradiction: a different figure for the same round, from a page
      // that is not the memo. Report-only; the corpus does not adjudicate it.
      'Round recap for the team. We closed a 5.1 million euro Series A last week and the paperwork is done.',
      'Thanks to everyone who sat through the diligence calls over the holidays.',
    ],
  },
  {
    id: 'p-tessellate-brackish',
    title: 'Brackish Labs follow-on',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2026-03-02',
    paragraphs: [
      'Brackish Labs follow-on. Tessellate wrote a second cheque into Brackish Labs this quarter.',
      'Brackish Labs makes estuary water testing kits. Priya Raghunathan sits on their board.',
    ],
  },
  {
    id: 'p-investing-newsletter',
    title: 'The Weekly Term Sheet',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2026-02-08',
    paragraphs: [
      'The Weekly Term Sheet. Everyone invested in seed rounds this week and investors invested more than they invested last year.',
      'Funds that invested early are re-investing. If you invested in hardware you invested in patience.',
      'This newsletter goes to investors who invested through the platform. Nobody here invested in vineyards.',
    ],
  },

  // ---------------------------------------------------------------------------
  // Title-substring probes and their body-text decoy.
  // ---------------------------------------------------------------------------
  {
    id: 'p-saltmarsh-retro',
    title: 'Saltmarsh launch retro',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2026-04-14',
    paragraphs: [
      'Saltmarsh launch retro. The launch shipped on 9 April, two days later than planned.',
      'What went well: the firmware rollback path worked on the first attempt.',
      'What did not: nobody owned the customer email, so it went out a day after the store page.',
    ],
  },
  {
    id: 'p-windbreak-status',
    title: 'Windbreak status update',
    sourceType: 'document',
    origin: 'work:files',
    createdAt: '2026-05-06',
    paragraphs: [
      'Windbreak status update. The project is in its second pilot with two regional water boards.',
      'Dana Ilves moved the ingest job to nightly batches, which cut the compute bill by a third.',
      'Open risk: the second board has not signed the data processing addendum.',
    ],
  },
  {
    id: 'p-standup-firehose',
    title: 'Weekly standup digest',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-04-10',
    paragraphs: [
      'saltmarsh launch retro? is the saltmarsh retro doc up yet? someone said the saltmarsh launch retro moved again',
      'windbreak status update, windbreak status update thread, the windbreak status update is stale, windbreak status',
      'halcyon grid renewal terms, the halcyon grid renewal terms doc, renewal terms for halcyon grid, halcyon grid renewal',
      'kettle and quill supplier list, the kettle and quill supplier list is missing, supplier list for kettle and quill',
      'verdant loom company overview, who has the verdant loom company overview, company overview for verdant loom',
    ],
  },
  {
    id: 'p-chat-firehose-two',
    title: 'Random channel',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-05-21',
    paragraphs: [
      'tessellate capital series a memo, anyone got the tessellate capital series a memo, series a memo tessellate',
      'kettle and quill relocation note, relocation note for kettle and quill, kettle and quill relocation',
      'firmware 3.4.1 hotfix, is the firmware 3.4.1 hotfix out, hotfix 3.4.1 firmware, firmware hotfix',
      'engineering leadership change, the engineering leadership change email, leadership change engineering',
      'brackish labs follow-on, brackish labs follow-on doc, follow-on for brackish labs',
    ],
  },
  {
    id: 'p-chat-firehose-three',
    title: 'Off topic',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-06-25',
    paragraphs: [
      'dana ilves who she is, who is dana ilves, dana ilves who she is again',
      'membership renewal, the membership renewal mail, renewal membership, membership renewal price',
      'quarterly review attendees, who are the quarterly review attendees, attendees quarterly review',
      'northwind vendor list, the northwind vendor list, vendor list northwind, northwind vendor',
      'priya raghunathan introduction, the priya raghunathan introduction, introduction priya raghunathan',
    ],
  },

  {
    id: 'p-chat-firehose-four',
    title: 'Docs channel',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-06-28',
    paragraphs: [
      'project saltmarsh charter, the project saltmarsh charter link, saltmarsh charter, charter for project saltmarsh',
      'design review notes, where are the design review notes, notes from the design review, design review',
      'marcus vandenberg, ask marcus vandenberg, marcus vandenberg has it, marcus vandenberg again',
      'payment confirmation, the payment confirmation mail, confirmation of payment, payment confirmation please',
      'roast price change, is there a roast price change, price change on the roast, roast price',
    ],
  },
  {
    // The work-grant decoy. Personal chat is invisible under a work grant, so
    // without this the work-fenced probes would have no competition at all and
    // the lower-bound receipt would flatter the corpus.
    id: 'p-work-notes-firehose',
    title: 'Notes to self',
    sourceType: 'document',
    origin: 'work:files',
    createdAt: '2026-06-26',
    paragraphs: [
      'windbreak status update — chase the windbreak status update, windbreak status update owner, status update windbreak',
      'northwind analytics background, read the northwind analytics background, background on northwind analytics',
      'halcyon grid background, halcyon grid background doc, background for halcyon grid, halcyon grid background again',
      'northwind vendor list, check the northwind vendor list, vendor list for northwind, supplier list northwind',
      'pilot outcome, write up the pilot outcome, the pilot outcome note, pilot outcome summary',
    ],
  },
  {
    id: 'p-work-digest',
    title: 'Team digest',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-06-27',
    paragraphs: [
      'halcyon grid renewal terms, the halcyon grid renewal terms, renewal terms halcyon grid, halcyon grid renewal terms again',
      'quarterly review attendees, confirm the quarterly review attendees, attendees for the quarterly review, review attendees',
      'data processing addendum, the data processing addendum thread, addendum for data processing, processing addendum',
      'addendum signature status, chase the addendum signature status, signature status of the addendum, signature status',
    ],
  },

  // ---------------------------------------------------------------------------
  // Unanswered questions.
  //
  // A brain fed from chat and mail is full of people asking the thing the brain
  // is later asked, and answering nothing. These pages are that population, and
  // they are the single most effective decoy in the corpus against a keyword
  // arm: a question shares almost every content word with the query it mirrors,
  // is short enough to win on length normalisation, and carries no answer at all.
  //
  // Beating them is not a trick. It is what the source-type priors, the intent
  // signal and the graph arm are for — a question in a chat channel is the wrong
  // *kind* of row to answer with, and the page that does answer is reachable
  // through the edge whether or not it repeats the question's words.
  // ---------------------------------------------------------------------------
  {
    id: 'p-questions-personal-a',
    title: 'Asks channel',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-06-30',
    paragraphs: [
      'who invested in verdant loom? did anyone else invest in verdant loom, or was it one investor who invested?',
      'who founded kettle and quill? someone must know who founded it. founded in what year, and who founded it with whom?',
      'who advises kettle and quill on anything? is there an adviser, does anyone advise them, who advises?',
      'what is project saltmarsh part of? saltmarsh is part of what exactly, and who owns the part it is part of?',
      'where does toshiro abe work now? toshiro abe works where these days, does toshiro abe still work there?',
      'who sponsored the series a internally? someone sponsored it, which partner sponsored the series a?',
      'which fund is priya at? priya is at which fund now, has priya moved fund, which fund?',
      'who owns the design at verdant loom? design ownership at verdant loom, who owns design there?',
    ],
  },
  {
    id: 'p-questions-personal-b',
    title: 'More asks',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-07-01',
    paragraphs: [
      'who negotiates the roast contract? does anyone negotiate the roast contract, who negotiates it each year?',
      'sensor housing change? was there a sensor housing change, what changed on the sensor housing?',
      'who does samantha work with on water data? samantha and water data, who works with samantha on it?',
      'renewal price for 2026? what is the renewal price for 2026, has anyone got the 2026 renewal price?',
      'supplier list? where is the supplier list, does the supplier list exist, supplier list anyone?',
      'what is happening on 3 september? anything on 3 september, is 3 september free, 3 september?',
      'the dentist appointment? when is the dentist appointment, did the dentist appointment move?',
      'where is kettle and quill based now? based where now, kettle and quill based in which town now?',
    ],
  },
  {
    id: 'p-questions-work',
    title: 'Open questions',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-06-29',
    paragraphs: [
      'which company employs elena barros? elena barros is employed by which company, who employs elena barros?',
      'which project does northwind run? northwind runs which project, what project does northwind analytics run?',
      'who joined the windbreak pilot as an analyst? which analyst joined the windbreak pilot, an analyst joined?',
      'compute vendor? who is the compute vendor, which vendor supplies compute, compute vendor name?',
      'who chairs the quarterly review? the quarterly review chair, who chairs it, chair of the quarterly review?',
      'self assessment deadline? what is the self assessment deadline, when is self assessment due, deadline?',
      'when did the pilot end? did the pilot end yet, when did it end, has the pilot ended?',
      'telemetry retention period? what is the telemetry retention period, how long is telemetry retained?',
    ],
  },
  {
    id: 'p-questions-work-b',
    title: 'Parked items',
    sourceType: 'document',
    origin: 'work:files',
    createdAt: '2026-06-30',
    paragraphs: [
      'renewal price for 2026 — nobody has the renewal price for 2026 yet, chase the 2026 renewal price.',
      'supplier list — the supplier list is unconfirmed, we need a supplier list, whose supplier list is current?',
      'what is happening on 3 september — 3 september is unclear, check what is happening on 3 september.',
      'did the renewal price change? the renewal price may have changed, has the renewal price changed at all?',
      'current price for the compute account — what is the current price for the compute account now?',
      'ellie renewal price — ask ellie about the renewal price, ellie has the renewal price somewhere.',
    ],
  },

  // ---------------------------------------------------------------------------
  // Temporal pairs: the stale page is the denser one, every time.
  // ---------------------------------------------------------------------------
  {
    id: 'p-halcyon-renewal-2026',
    title: 'Halcyon Grid renewal terms',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-06-18',
    paragraphs: [
      'Halcyon Grid renewal terms. The 2026 price is 18,400 euro for the year.',
      'Elena Barros confirmed it holds if we commit before 31 July.',
    ],
  },
  {
    id: 'p-halcyon-renewal-2025',
    title: 'Halcyon Grid renewal terms 2025',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2025-06-20',
    paragraphs: [
      'Halcyon Grid renewal terms 2025. The renewal price is 14,900 euro. Renewal terms, renewal price and renewal window are unchanged.',
      'Renewal terms confirmed by Halcyon Grid billing. The renewal price of 14,900 euro is the renewal price for the renewal year.',
    ],
  },
  {
    id: 'p-sam-promotion',
    title: 'Engineering leadership change',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2026-02-27',
    paragraphs: [
      'Engineering leadership change. Samantha Okonkwo becomes CTO of Verdant Loom on 1 March 2026.',
      'Toshiro Abe takes the product design lead alongside his existing work.',
    ],
  },
  {
    id: 'p-sam-old-title',
    title: 'New starter introductions',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2024-03-12',
    paragraphs: [
      'New starter introductions. Samantha Okonkwo is Head of Engineering. As Head of Engineering, Samantha Okonkwo owns the roadmap.',
      'Head of Engineering is a new role here. Samantha Okonkwo reports to the founders. Samantha Okonkwo starts on Monday.',
    ],
  },
  {
    id: 'p-kettle-move',
    title: 'Kettle and Quill relocation note',
    sourceType: 'note',
    origin: 'personal:files',
    createdAt: '2026-05-19',
    paragraphs: [
      'Kettle and Quill relocation note. The shop moved to Bristol in May 2026.',
      'The old lease ended and was not renewed.',
    ],
  },
  {
    id: 'p-kettle-portland',
    title: 'Kettle and Quill opening week',
    sourceType: 'note',
    origin: 'personal:files',
    createdAt: '2025-01-09',
    paragraphs: [
      'Kettle and Quill opening week. Kettle and Quill is based in Portland. The Portland shop opened on a Thursday.',
      'Portland regulars already have a usual. The Portland site seats twenty two. Portland was the obvious choice.',
    ],
  },
  {
    id: 'p-saltmarsh-ship-date-old',
    title: 'Saltmarsh plan of record',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2026-02-02',
    paragraphs: [
      'Saltmarsh plan of record. The Saltmarsh ship date is 7 April. Ship date, ship date, the Saltmarsh ship date is fixed.',
      'The Saltmarsh ship date drives the store page and the customer email.',
    ],
  },

  // ---------------------------------------------------------------------------
  // Alias probes and their lexical collisions.
  // ---------------------------------------------------------------------------
  {
    id: 'p-sam-trelawney',
    title: 'Northwind analyst rotation',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-03-30',
    paragraphs: [
      'Northwind analyst rotation. Sam Trelawney joins the Windbreak pilot as a junior analyst.',
      'Sam is on the rotation for eight weeks. Sam will shadow the data team. Ask Sam for the pilot notes.',
    ],
  },
  {
    id: 'p-mv-loadtest',
    title: 'MV load test results',
    sourceType: 'document',
    origin: 'work:files',
    createdAt: '2026-03-18',
    paragraphs: [
      'MV load test results. The MV rig held 4,000 requests a second before MV latency crossed the budget.',
      'MV numbers are from the staging cluster. Re-run MV after the next deploy. MV owns the regression.',
    ],
  },
  {
    id: 'p-mailing-footer',
    title: 'Distribution list',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-01-05',
    paragraphs: [
      'Distribution list: sokonkwo@example.com, tabe@example.com, dilves@example.com, praghu@example.com, ebarros@example.com.',
      'Reply-all is disabled on this list. Contact the office manager to be removed.',
    ],
  },
  {
    id: 'p-tosh-review',
    title: 'Design review notes',
    sourceType: 'note',
    origin: 'personal:files',
    createdAt: '2026-04-29',
    paragraphs: [
      'Design review notes. Toshiro Abe wants the sensor housing two millimetres shorter before tooling.',
      'He also asked for a single status light instead of three.',
    ],
  },
  {
    id: 'p-marcus-profile',
    title: 'Marcus Vandenberg',
    sourceType: 'note',
    origin: 'personal:files',
    createdAt: '2025-08-14',
    paragraphs: [
      'Marcus Vandenberg founded Kettle and Quill in 2019 after twelve years in restaurant supply.',
      'He is the only person who knows the roast contract history end to end.',
    ],
  },
  {
    id: 'p-priya-intro',
    title: 'Priya Raghunathan introduction',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2025-09-30',
    paragraphs: [
      'Priya Raghunathan introduction. Priya is a partner at Tessellate Capital and led our first conversation.',
      'She also advises Kettle and Quill on supplier financing.',
    ],
  },
  {
    id: 'p-elena-thread',
    title: 'Billing contact for the grid account',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-05-30',
    paragraphs: [
      'Billing contact for the grid account. Elena Barros handles the account and answers within a day.',
      'She has asked us to stop copying the shared inbox.',
    ],
  },

  // ---------------------------------------------------------------------------
  // Named-entity probes and their name-dense, characterless decoys.
  // ---------------------------------------------------------------------------
  {
    id: 'p-dana-profile',
    title: 'Dana Ilves who she is',
    sourceType: 'note',
    origin: 'personal:files',
    createdAt: '2026-01-15',
    paragraphs: [
      'Dana Ilves is the data lead at Northwind Analytics and has run their pipeline since 2022.',
      'She is who to ask about ingest scheduling and about anything touching water board data.',
    ],
  },
  {
    id: 'p-northwind-invite-list',
    title: 'Quarterly review attendees',
    sourceType: 'calendar',
    origin: 'work:calendar',
    createdAt: '2026-04-02',
    paragraphs: [
      'Quarterly review attendees: Dana Ilves, Dana Ilves (optional), Sam Trelawney, Northwind Analytics, Northwind Analytics finance.',
      'Northwind Analytics room 3. Northwind Analytics dial-in. Dana Ilves to chair. Northwind Analytics catering ordered.',
    ],
  },
  {
    id: 'p-northwind-profile',
    title: 'Northwind Analytics background',
    sourceType: 'document',
    origin: 'work:files',
    createdAt: '2025-12-04',
    paragraphs: [
      'Northwind Analytics background. They process water quality telemetry for regional boards and have done since 2016.',
      'Roughly forty people, split between the lab and the data team.',
    ],
  },
  {
    id: 'p-halcyon-profile',
    title: 'Halcyon Grid background',
    sourceType: 'document',
    origin: 'work:files',
    createdAt: '2025-10-11',
    paragraphs: [
      'Halcyon Grid background. They resell metered compute to research groups and bill annually in advance.',
      'The company is small and the support desk is one person.',
    ],
  },
  {
    id: 'p-brackish-profile',
    title: 'Brackish Labs background',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2026-03-05',
    paragraphs: [
      'Brackish Labs background. They build estuary water testing kits sold to conservation trusts.',
      'Four people, one of whom used to work on the Windbreak pilot.',
    ],
  },
  {
    id: 'p-saltmarsh-charter',
    title: 'Project Saltmarsh charter',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2025-12-18',
    paragraphs: [
      'Project Saltmarsh charter. Saltmarsh is the vineyard sensor programme and it belongs to Verdant Loom.',
      'Scope is the sensor, the app and the subscription billing, and nothing else.',
    ],
  },

  // ---------------------------------------------------------------------------
  // Duplicate cluster D1 — the firmware advisory, in three places.
  // ---------------------------------------------------------------------------
  {
    id: 'p-fwd-advisory-personal',
    title: 'Fwd: sensor firmware advisory',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2026-06-02',
    dupGroup: 'dup-advisory',
    paragraphs: [
      'Sensor firmware advisory. Firmware 3.4 has a battery drain bug on the older sensor board. Do not ship 3.4 to vineyard customers.',
    ],
  },
  {
    id: 'p-fwd-advisory-work',
    title: 'Fwd: sensor firmware advisory',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-06-02',
    dupGroup: 'dup-advisory',
    paragraphs: [
      'Sensor firmware advisory. Firmware 3.4 has a battery drain bug on the older sensor board. Do not ship 3.4 to vineyard customers.',
    ],
  },
  {
    id: 'p-chat-advisory-paste',
    title: 'Firmware chat',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-06-02',
    dupGroup: 'dup-advisory',
    paragraphs: [
      'pasting this here: Firmware 3.4 has a battery drain bug on the older sensor board. Do not ship 3.4 to vineyard customers.',
    ],
  },
  {
    id: 'p-firmware-fix',
    title: 'Firmware 3.4.1 hotfix',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2026-06-09',
    dupGroup: 'dup-firmware-fix',
    paragraphs: [
      'Firmware 3.4.1 hotfix. The drain is fixed in 3.4.1 and the change is a sleep timer on the radio.',
      'Ship 3.4.1 to customers and withdraw the advisory.',
    ],
  },

  // ---------------------------------------------------------------------------
  // Duplicate cluster D2 — an invoice, and the fact that it was paid.
  // ---------------------------------------------------------------------------
  {
    id: 'p-invoice-personal',
    title: 'Invoice 2026-114',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2026-05-02',
    dupGroup: 'dup-invoice',
    paragraphs: [
      'Invoice 2026-114 from Green Harbour, 1,260 euro, due 30 days from issue. Reference 2026-114 on the transfer.',
    ],
  },
  {
    id: 'p-invoice-work',
    title: 'Fwd: Invoice 2026-114',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-05-02',
    dupGroup: 'dup-invoice',
    paragraphs: [
      'Invoice 2026-114 from Green Harbour, 1,260 euro, due 30 days from issue. Reference 2026-114 on the transfer.',
    ],
  },
  {
    id: 'p-invoice-chat',
    title: 'Accounts chat',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-05-03',
    dupGroup: 'dup-invoice',
    paragraphs: [
      'copying it in: Invoice 2026-114 from Green Harbour, 1,260 euro, due 30 days from issue. Reference 2026-114 on the transfer.',
    ],
  },
  {
    id: 'p-invoice-paid',
    title: 'Payment confirmation',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2026-05-21',
    dupGroup: 'dup-invoice-paid',
    paragraphs: [
      'Payment confirmation. 2026-114 was settled on 21 May by transfer and Green Harbour has acknowledged it.',
    ],
  },

  // ---------------------------------------------------------------------------
  // Duplicate cluster D3 — the data processing addendum, and its signature state.
  // ---------------------------------------------------------------------------
  {
    id: 'p-dpa-mail',
    title: 'Data processing addendum',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-04-20',
    dupGroup: 'dup-dpa',
    paragraphs: [
      'Data processing addendum. The addendum covers telemetry retention at twenty four months and names two sub-processors.',
    ],
  },
  {
    id: 'p-dpa-file',
    title: 'Data processing addendum (copy)',
    sourceType: 'document',
    origin: 'work:files',
    createdAt: '2026-04-20',
    dupGroup: 'dup-dpa',
    paragraphs: [
      'Data processing addendum. The addendum covers telemetry retention at twenty four months and names two sub-processors.',
    ],
  },
  {
    id: 'p-dpa-chat',
    title: 'Compliance chat',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-04-21',
    dupGroup: 'dup-dpa',
    paragraphs: [
      'quoting it: Data processing addendum. The addendum covers telemetry retention at twenty four months and names two sub-processors.',
    ],
  },
  {
    id: 'p-dpa-status',
    title: 'Addendum signature status',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-06-11',
    dupGroup: 'dup-dpa-status',
    paragraphs: [
      'Addendum signature status. The first water board signed on 5 June; the second has not returned it.',
    ],
  },

  // ---------------------------------------------------------------------------
  // Duplicate cluster D4 — the roast contract, and this year's price change.
  // ---------------------------------------------------------------------------
  {
    id: 'p-roast-file',
    title: 'Roast contract terms',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2026-02-14',
    dupGroup: 'dup-roast',
    paragraphs: [
      'Roast contract terms. Green Harbour roasts the house blend weekly with a twelve month term and a ninety day exit.',
    ],
  },
  {
    id: 'p-roast-mail',
    title: 'Fwd: Roast contract terms',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2026-02-14',
    dupGroup: 'dup-roast',
    paragraphs: [
      'Roast contract terms. Green Harbour roasts the house blend weekly with a twelve month term and a ninety day exit.',
    ],
  },
  {
    id: 'p-roast-chat',
    title: 'Shop chat',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-02-15',
    dupGroup: 'dup-roast',
    paragraphs: [
      'for the record: Roast contract terms. Green Harbour roasts the house blend weekly with a twelve month term and a ninety day exit.',
    ],
  },
  {
    id: 'p-roast-price',
    title: 'Roast price change',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2026-06-05',
    dupGroup: 'dup-roast-price',
    paragraphs: [
      'Roast price change. The house blend goes to 9.40 a kilo from July, which is the first rise in two years.',
    ],
  },

  // ---------------------------------------------------------------------------
  // Duplicate cluster D5 — the pilot brief, and how the pilot actually went.
  // ---------------------------------------------------------------------------
  {
    id: 'p-pilot-brief-file',
    title: 'Windbreak pilot brief',
    sourceType: 'document',
    origin: 'work:files',
    createdAt: '2026-03-09',
    dupGroup: 'dup-pilot',
    paragraphs: [
      'Windbreak pilot brief. Two boards, eight weeks, telemetry ingested nightly and reviewed at the end of each fortnight.',
    ],
  },
  {
    id: 'p-pilot-brief-mail',
    title: 'Fwd: Windbreak pilot brief',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-03-09',
    dupGroup: 'dup-pilot',
    paragraphs: [
      'Windbreak pilot brief. Two boards, eight weeks, telemetry ingested nightly and reviewed at the end of each fortnight.',
    ],
  },
  {
    id: 'p-pilot-brief-chat',
    title: 'Pilot channel',
    sourceType: 'chat',
    origin: 'personal:chat',
    createdAt: '2026-03-10',
    dupGroup: 'dup-pilot',
    paragraphs: [
      'here it is: Windbreak pilot brief. Two boards, eight weeks, telemetry ingested nightly and reviewed at the end of each fortnight.',
    ],
  },
  {
    id: 'p-pilot-outcome',
    title: 'Pilot outcome',
    sourceType: 'document',
    origin: 'work:files',
    createdAt: '2026-06-20',
    dupGroup: 'dup-pilot-outcome',
    paragraphs: [
      'Pilot outcome. Both boards kept the nightly schedule and one asked to extend by a quarter.',
    ],
  },

  // ---------------------------------------------------------------------------
  // Context-fenced pairs: same question, different grant, different answer.
  // ---------------------------------------------------------------------------
  {
    id: 'p-gym-renewal',
    title: 'Membership renewal',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2026-06-21',
    paragraphs: [
      'Membership renewal. The 2026 price for the climbing gym is 540 euro for the year.',
      'It renews automatically unless cancelled before 30 June.',
    ],
  },
  {
    id: 'p-northwind-vendor-list',
    title: 'Northwind vendor list',
    sourceType: 'document',
    origin: 'work:files',
    createdAt: '2026-04-25',
    paragraphs: [
      'Northwind vendor list. The approved supplier list is Halcyon Grid for compute, Riverbend for couriers, and one lab consumables account.',
      'Everything else goes through the central purchasing card.',
    ],
  },
  {
    id: 'p-personal-calendar-dentist',
    title: 'Appointments',
    sourceType: 'calendar',
    origin: 'personal:calendar',
    createdAt: '2026-06-14',
    paragraphs: [
      'Appointments. The next dentist visit is 3 September at ten past nine.',
      'The optician wants a new appointment before December.',
    ],
  },
  {
    id: 'p-work-calendar-review',
    title: 'Review cycle dates',
    sourceType: 'calendar',
    origin: 'work:calendar',
    createdAt: '2026-06-14',
    paragraphs: [
      'Review cycle dates. The next review window opens 3 September and closes on the 24th.',
      'Self assessments are due a week before the window opens.',
    ],
  },
  {
    id: 'p-kettle-supplier-list',
    title: 'Kettle and Quill supplier list',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2026-02-11',
    paragraphs: [
      'Kettle and Quill supplier list. Green Harbour roasts the house blend and the pastry supplier is a family bakery.',
      'Marcus Vandenberg renegotiates the roast contract every February.',
    ],
  },

  // ---------------------------------------------------------------------------
  // The two invisible pages. Both are strong lexical matches for live queries,
  // which is what makes them worth having: a stack that forgets the predicate
  // does not fail quietly here.
  // ---------------------------------------------------------------------------
  {
    id: 'p-deleted-old-renewal',
    title: 'Halcyon Grid renewal terms draft',
    sourceType: 'email',
    origin: 'work:mail',
    createdAt: '2026-06-01',
    deletedAt: '2026-06-17',
    paragraphs: [
      'Halcyon Grid renewal terms draft. The renewal price is 21,000 euro. Renewal terms, renewal price, renewal draft, renewal.',
      'This draft was superseded before it was sent and should not be quoted.',
    ],
  },
  {
    id: 'p-quarantined-spam',
    title: 'Firmware update required',
    sourceType: 'email',
    origin: 'personal:mail',
    createdAt: '2026-06-03',
    quarantinedAt: '2026-06-03',
    paragraphs: [
      'Firmware update required. Firmware 3.4 battery drain sensor board firmware firmware firmware update your sensor board now.',
      'Click through to claim your free replacement sensor board today.',
    ],
  },
];

/**
 * Extracted claims and their sources.
 *
 * Supersession rather than deletion is what makes the temporal questions have a
 * right answer: the stale claim is still in the brain, still retrievable, still
 * lexically louder than its replacement, and still wrong.
 */
export const FACTS: readonly FixtureFact[] = [
  {
    id: 'f-tessellate-invested-verdant',
    statement: 'Tessellate Capital invested in Verdant Loom.',
    sourceChunks: ['p-tessellate-memo#0', 'p-tessellate-memo#1'],
    validFrom: '2026-01-22',
  },
  {
    id: 'f-tessellate-invested-brackish',
    statement: 'Tessellate Capital invested in Brackish Labs.',
    sourceChunks: ['p-tessellate-brackish#0'],
    validFrom: '2026-03-02',
  },
  {
    id: 'f-sam-works-verdant',
    statement: 'Samantha Okonkwo works at Verdant Loom.',
    sourceChunks: ['p-verdant-overview#2'],
    validFrom: '2024-03-12',
  },
  {
    id: 'f-tosh-works-verdant',
    statement: 'Toshiro Abe works at Verdant Loom.',
    sourceChunks: ['p-verdant-overview#2'],
    validFrom: '2024-03-12',
  },
  {
    id: 'f-dana-works-northwind',
    statement: 'Dana Ilves works at Northwind Analytics.',
    sourceChunks: ['p-dana-profile#0'],
    validFrom: '2022-01-01',
  },
  {
    id: 'f-trelawney-works-northwind',
    statement: 'Sam Trelawney works at Northwind Analytics.',
    sourceChunks: ['p-sam-trelawney#0'],
    validFrom: '2026-03-30',
  },
  {
    id: 'f-elena-works-halcyon',
    statement: 'Elena Barros works at Halcyon Grid.',
    sourceChunks: ['p-elena-thread#0'],
    validFrom: '2026-05-30',
  },
  {
    id: 'f-priya-works-tessellate',
    statement: 'Priya Raghunathan works at Tessellate Capital.',
    sourceChunks: ['p-priya-intro#0'],
    validFrom: '2025-09-30',
  },
  {
    id: 'f-marcus-founded-kettle',
    statement: 'Marcus Vandenberg founded Kettle and Quill.',
    sourceChunks: ['p-marcus-profile#0'],
    validFrom: '2019-01-01',
  },
  {
    id: 'f-priya-advises-kettle',
    statement: 'Priya Raghunathan advises Kettle and Quill.',
    sourceChunks: ['p-priya-intro#1'],
    validFrom: '2025-09-30',
  },
  {
    id: 'f-sam-collab-dana',
    statement: 'Samantha Okonkwo works jointly with Dana Ilves on water data.',
    sourceChunks: ['p-dana-profile#1'],
    validFrom: '2026-01-15',
  },
  {
    id: 'f-saltmarsh-part-of-verdant',
    statement: 'Project Saltmarsh is part of Verdant Loom.',
    sourceChunks: ['p-saltmarsh-charter#0'],
    validFrom: '2025-12-18',
  },
  {
    id: 'f-windbreak-part-of-northwind',
    statement: 'Project Windbreak is part of Northwind Analytics.',
    sourceChunks: ['p-windbreak-status#0', 'p-northwind-profile#0'],
    validFrom: '2026-03-09',
  },

  // Temporal pairs. The superseded row stays retrievable on purpose.
  {
    id: 'f-sam-title-old',
    statement: 'Samantha Okonkwo is Head of Engineering at Verdant Loom.',
    sourceChunks: ['p-sam-old-title#0'],
    validFrom: '2024-03-12',
    supersededBy: 'f-sam-title-current',
  },
  {
    id: 'f-sam-title-current',
    statement: 'Samantha Okonkwo is CTO of Verdant Loom.',
    sourceChunks: ['p-sam-promotion#0'],
    validFrom: '2026-03-01',
  },
  {
    id: 'f-kettle-base-old',
    statement: 'Kettle and Quill is based in Portland.',
    sourceChunks: ['p-kettle-portland#0'],
    validFrom: '2025-01-09',
    supersededBy: 'f-kettle-base-current',
  },
  {
    id: 'f-kettle-base-current',
    statement: 'Kettle and Quill is based in Bristol.',
    sourceChunks: ['p-kettle-move#0'],
    validFrom: '2026-05-19',
  },
  {
    id: 'f-halcyon-price-old',
    statement: 'The Halcyon Grid annual renewal price is 14,900 euro.',
    sourceChunks: ['p-halcyon-renewal-2025#0'],
    validFrom: '2025-06-20',
    supersededBy: 'f-halcyon-price-current',
  },
  {
    id: 'f-halcyon-price-current',
    statement: 'The Halcyon Grid annual renewal price is 18,400 euro.',
    sourceChunks: ['p-halcyon-renewal-2026#0'],
    validFrom: '2026-06-18',
  },
  {
    id: 'f-saltmarsh-ship-old',
    statement: 'Project Saltmarsh ships on 7 April 2026.',
    sourceChunks: ['p-saltmarsh-ship-date-old#0'],
    validFrom: '2026-02-02',
    supersededBy: 'f-saltmarsh-ship-actual',
  },
  {
    id: 'f-saltmarsh-ship-actual',
    statement: 'Project Saltmarsh shipped on 9 April 2026.',
    sourceChunks: ['p-saltmarsh-retro#0'],
    validFrom: '2026-04-14',
  },
  {
    id: 'f-firmware-advisory',
    statement: 'Firmware 3.4 has a battery drain bug on the older sensor board.',
    sourceChunks: ['p-fwd-advisory-personal#0'],
    validFrom: '2026-06-02',
    supersededBy: 'f-firmware-fixed',
  },
  {
    id: 'f-firmware-fixed',
    statement: 'Firmware 3.4.1 fixes the battery drain bug.',
    sourceChunks: ['p-firmware-fix#0'],
    validFrom: '2026-06-09',
  },

  // The contradiction. Two live claims about the same round, neither superseded:
  // the corpus records the conflict, it does not resolve it.
  {
    id: 'f-series-a-amount-memo',
    statement: 'The Verdant Loom Series A was 4.2 million euro.',
    sourceChunks: ['p-tessellate-memo#1'],
    validFrom: '2026-01-22',
  },
  {
    id: 'f-series-a-amount-recap',
    statement: 'The Verdant Loom Series A was 5.1 million euro.',
    sourceChunks: ['p-verdant-round-recap#0'],
    validFrom: '2026-01-28',
  },
];

/**
 * The known contradiction, recorded so a later unit's contradiction report has a
 * seeded case with a known answer. It is `value_conflict` in the tenant schema's
 * vocabulary and it is deliberately left unresolved.
 */
export const CONTRADICTIONS: readonly {
  readonly id: string;
  readonly kind: 'value_conflict' | 'temporal_conflict' | 'duplicate';
  readonly left: string;
  readonly right: string;
}[] = [
  {
    id: 'x-series-a-amount',
    kind: 'value_conflict',
    left: 'f-series-a-amount-memo',
    right: 'f-series-a-amount-recap',
  },
];

export const EDGES: readonly FixtureEdge[] = [
  {
    subject: 'tessellate-capital',
    type: 'invested_in',
    object: 'verdant-loom',
    factIds: ['f-tessellate-invested-verdant'],
  },
  {
    subject: 'tessellate-capital',
    type: 'invested_in',
    object: 'brackish-labs',
    factIds: ['f-tessellate-invested-brackish'],
  },
  {
    subject: 'samantha-okonkwo',
    type: 'works_at',
    object: 'verdant-loom',
    factIds: ['f-sam-works-verdant'],
  },
  {
    subject: 'toshiro-abe',
    type: 'works_at',
    object: 'verdant-loom',
    factIds: ['f-tosh-works-verdant'],
  },
  {
    subject: 'dana-ilves',
    type: 'works_at',
    object: 'northwind-analytics',
    factIds: ['f-dana-works-northwind'],
  },
  {
    subject: 'sam-trelawney',
    type: 'works_at',
    object: 'northwind-analytics',
    factIds: ['f-trelawney-works-northwind'],
  },
  {
    subject: 'elena-barros',
    type: 'works_at',
    object: 'halcyon-grid',
    factIds: ['f-elena-works-halcyon'],
  },
  {
    subject: 'priya-raghunathan',
    type: 'works_at',
    object: 'tessellate-capital',
    factIds: ['f-priya-works-tessellate'],
  },
  {
    subject: 'marcus-vandenberg',
    type: 'founded',
    object: 'kettle-and-quill',
    factIds: ['f-marcus-founded-kettle'],
  },
  {
    subject: 'priya-raghunathan',
    type: 'advises',
    object: 'kettle-and-quill',
    factIds: ['f-priya-advises-kettle'],
  },
  {
    subject: 'samantha-okonkwo',
    type: 'collaborates_with',
    object: 'dana-ilves',
    factIds: ['f-sam-collab-dana'],
  },
  {
    subject: 'project-saltmarsh',
    type: 'part_of',
    object: 'verdant-loom',
    factIds: ['f-saltmarsh-part-of-verdant'],
  },
  {
    subject: 'project-windbreak',
    type: 'part_of',
    object: 'northwind-analytics',
    factIds: ['f-windbreak-part-of-northwind'],
  },
];
