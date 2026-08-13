/**
 * R10's register, checked against the code rather than against itself.
 *
 * **The trivially-passing version of this file is the one worth naming.** A
 * check that reads `docs/register.md`, parses it, and asserts it contains what
 * `components.ts` says always passes: it compares a rendering to its own source.
 * The register would then be complete by construction and wrong in fact, which
 * is the failure mode R10 exists against — the point of naming every shared
 * component is that adding one becomes *visible before it is paid for*.
 *
 * So completeness is asserted against three evidence sets, each derived from
 * something the register does not author:
 *
 *   1. **Every external host the code can name.** A sweep for `http(s)://`
 *      literals across `src/**\/*.ts`. This is the crude one and the hardest to
 *      evade: a new vendor arrives as a hostname in a source file, and it turns
 *      the register red the moment it does.
 *   2. **Every provider a routing profile can reach.** `PROFILES` in
 *      `src/ai/routing.ts`, reduced to `Route.provider`. This is KTD13's "two
 *      model-side processors" claim made checkable — a third provider row turns
 *      the register red before it turns the subprocessor list wrong.
 *   3. **Every binding the fleet declares.** `wrangler.toml`'s Durable Object
 *      bindings and container classes, so "the MCP fleet" and "the worker fleet"
 *      are entries derived from the deployment surface rather than remembered.
 *
 * **Both directions, like the hazard sweep.** An unclassified host is a
 * component nobody named. A register entry whose evidence matches nothing is a
 * component that was removed and is still being claimed — a blast-radius list
 * naming a vendor the code no longer calls is a list nobody has read recently.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { PROFILES } from '../ai/routing.ts';
import { NOT_A_DESTINATION, SHARED_COMPONENTS, type RegisterEntry } from './components.ts';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;

export interface RegisterEvidence {
  /** Distinct hosts named in `src/**\/*.ts`, with the files that name them. */
  readonly hosts: ReadonlyMap<string, readonly string[]>;
  /** Distinct provider ids any routing profile can reach. */
  readonly providers: readonly string[];
  /** Binding names and container classes `wrangler.toml` declares. */
  readonly bindings: readonly string[];
}

/** Every `.ts` file under `dir`, relative to the repo root. */
export function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];

  const walk = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const full = join(path, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (full.endsWith('.ts')) found.push(relative(REPO_ROOT, full));
    }
  };

  walk(join(REPO_ROOT, dir));
  return found.sort();
}

/**
 * Hosts named in source, keyed by host.
 *
 * Deliberately crude — a literal scan rather than an import graph. An import
 * graph would miss a hostname assembled at runtime and would need maintaining;
 * a literal scan over-reports (a hostname in a comment counts) and over-
 * reporting is the correct direction of error for a blast-radius list. Every
 * over-report is answered once, in `NOT_A_DESTINATION`, with a reason.
 */
export function hostsNamedIn(files: readonly string[]): Map<string, string[]> {
  const hosts = new Map<string, string[]>();

  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const match of text.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
      const host = match[1];
      if (host === undefined || host.length === 0) continue;
      // Loopback is not a destination anything ships to, and enumerating it
      // would put every test DSN in the register.
      if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) continue;
      const naming = hosts.get(host) ?? [];
      if (!naming.includes(file)) naming.push(file);
      hosts.set(host, naming);
    }
  }

  return hosts;
}

/** Every provider id reachable through any shipped routing profile. */
export function providersReachable(): string[] {
  const providers = new Set<string>();
  for (const profile of Object.values(PROFILES)) {
    for (const route of Object.values(profile.routes)) providers.add(route.provider);
  }
  return [...providers].sort();
}

/** Binding names and container classes, read out of the deployment manifest. */
export function bindingsDeclared(toml: string): string[] {
  const bindings = new Set<string>();
  for (const match of toml.matchAll(/^\s*(?:name|class_name|bucket_name|queue)\s*=\s*"([^"]+)"/gm)) {
    const value = match[1];
    if (value !== undefined) bindings.add(value);
  }
  return [...bindings].sort();
}

export function collectEvidence(): RegisterEvidence {
  return {
    hosts: hostsNamedIn(sourceFilesUnder('src')),
    providers: providersReachable(),
    bindings: bindingsDeclared(readFileSync(join(REPO_ROOT, 'wrangler.toml'), 'utf8')),
  };
}

/**
 * Everything the register does not account for, and everything it accounts for
 * that is no longer there.
 *
 * Findings rather than a throw, so a reader sees the whole gap at once: an
 * author who adds a vendor usually adds one hostname and one provider row in
 * the same change, and reporting them one restart at a time is how a guard
 * teaches people to route around it.
 */
export function findRegisterGaps(
  register: readonly RegisterEntry[] = SHARED_COMPONENTS,
  evidence: RegisterEvidence = collectEvidence(),
  excused: readonly { readonly host: string; readonly reason: string }[] = NOT_A_DESTINATION,
): string[] {
  const findings: string[] = [];

  const claimedHosts = new Set(register.flatMap((entry) => entry.evidence.hosts ?? []));
  const claimedProviders = new Set(register.flatMap((entry) => entry.evidence.providers ?? []));
  const claimedBindings = new Set(register.flatMap((entry) => entry.evidence.bindings ?? []));
  const excusedHosts = new Map(excused.map((entry) => [entry.host, entry.reason]));

  for (const [host, files] of [...evidence.hosts].sort()) {
    if (claimedHosts.has(host)) continue;
    if (excusedHosts.has(host)) continue;
    findings.push(
      `${host} is named in ${files.join(', ')} and appears in no register entry — say what it is, who it shares, and who rotates it, or list it as not-a-destination with a reason`,
    );
  }

  for (const provider of evidence.providers) {
    if (claimedProviders.has(provider)) continue;
    findings.push(
      `a routing profile can reach the provider ${JSON.stringify(provider)} and no register entry names it — a model destination is a subprocessor, not a config edit`,
    );
  }

  for (const binding of evidence.bindings) {
    if (claimedBindings.has(binding)) continue;
    findings.push(
      `wrangler.toml declares ${JSON.stringify(binding)} and no register entry names it — a deployed binding is a component shared by every tenant it serves`,
    );
  }

  // The reverse direction. A register that keeps naming a vendor the code no
  // longer calls is a list nobody has read since it was written, and it inflates
  // the blast radius an outsider is asked to audit.
  for (const entry of register) {
    for (const host of entry.evidence.hosts ?? []) {
      if (evidence.hosts.has(host)) continue;
      findings.push(
        `${entry.id} claims the host ${host}, which no source file names any more — a stale entry overstates the blast radius`,
      );
    }
    for (const provider of entry.evidence.providers ?? []) {
      if (evidence.providers.includes(provider)) continue;
      findings.push(
        `${entry.id} claims the provider ${JSON.stringify(provider)}, which no routing profile can reach any more`,
      );
    }
    for (const binding of entry.evidence.bindings ?? []) {
      if (evidence.bindings.includes(binding)) continue;
      findings.push(`${entry.id} claims the binding ${JSON.stringify(binding)}, which wrangler.toml no longer declares`);
    }
  }

  for (const { host } of excused) {
    if (evidence.hosts.has(host)) continue;
    findings.push(
      `${host} is excused as not-a-destination and no source file names it — an excuse outliving its subject is one nobody re-read`,
    );
  }

  return findings;
}
