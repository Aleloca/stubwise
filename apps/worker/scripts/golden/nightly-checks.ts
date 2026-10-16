import { type Check, type ToolCall, toolOutcome } from "./checks.js";
import { NEW_AREA_PREFIX, type NightlyFixture, type SeedPage } from "./nightly-fixture.js";

/**
 * I check del golden `nightly`, PURI: ricevono ciò che lo script ha letto dal
 * database (e dai run) e rispondono sì/no con il dettaglio che un umano legge
 * quando un check è rosso. Testati in `nightly-checks.test.ts` senza modello.
 */

/** Ciò che il golden legge dal database dopo la notte. */
export interface NightSnapshot {
  result: { stoppedForQuota: boolean; itemsPending: number; skipped: unknown[] };
  summaries: { sha: string; model: string | null; noise: boolean; onDefaultBranch: boolean; documented: boolean }[];
  /** Le pagine del repository dopo la notte (generazione corrente e pagine persistenti). */
  pages: { id: string; slug: string; kind: string; sourcePath: string | null; body: string; generationId: string | null }[];
  items: { phase: string; key: string; status: string; lastError: string | null }[];
  /** `doc_generations.commit_sha` della generazione corrente. */
  bookmark: string | null;
}

/** Le pagine seminate, col loro id. */
export type SeededPage = SeedPage & { id: string };

const short = (sha: string) => sha.slice(0, 7);

export function nightChecks(snap: NightSnapshot, fx: NightlyFixture, seeded: SeededPage[], generationId: string): Check[] {
  const checks: Check[] = [];

  checks.push({
    name: "il giro finisce: nessuno stop per quota, nessun repository saltato, niente in attesa",
    passed: !snap.result.stoppedForQuota && snap.result.skipped.length === 0 && snap.result.itemsPending === 0,
    detail: `stoppedForQuota=${snap.result.stoppedForQuota}, skipped=${JSON.stringify(snap.result.skipped)}, itemsPending=${snap.result.itemsPending}`,
  });

  const bySha = new Map(snap.summaries.map((s) => [s.sha, s]));
  const wrong: string[] = [];
  for (const c of fx.commits) {
    const s = bySha.get(c.sha);
    if (!s) wrong.push(`${c.kind} ${short(c.sha)}: nessun riassunto`);
    else if (c.kind === "noise" && (!s.noise || s.model !== null)) {
      wrong.push(`${c.kind}: atteso deterministico (noise, senza modello), trovato noise=${s.noise} model=${s.model}`);
    } else if (c.kind !== "noise" && (s.noise || s.model === null)) {
      wrong.push(`${c.kind}: atteso col modello, trovato noise=${s.noise} model=${s.model}`);
    }
  }
  const withModel = fx.commits.filter((c) => c.kind !== "noise" && bySha.get(c.sha)?.model);
  checks.push({
    name: "4 riassunti col modello + 1 deterministico",
    passed: wrong.length === 0,
    detail: wrong.length === 0 ? `${withModel.length} col modello (${withModel[0] ? bySha.get(withModel[0].sha)!.model : "-"}), 1 deterministico` : wrong.join(" | "),
  });

  const releases = snap.pages.filter((p) => p.kind === "releases");
  checks.push({
    name: "una nota di rilascio",
    passed: releases.length === 1 && snap.items.some((i) => i.phase === "release" && i.status === "done"),
    detail: `${releases.length} pagine releases (${releases.map((p) => p.slug).join(", ") || "nessuna"}); elementi release: ${snap.items
      .filter((i) => i.phase === "release")
      .map((i) => i.status)
      .join(", ") || "nessuno"}`,
  });

  const pageById = new Map(snap.pages.map((p) => [p.id, p]));
  const touched = seeded.filter((p) => p.touched);
  const outcome = touched.map((p) => {
    const item = snap.items.find((i) => i.phase === "page_update" && i.key.startsWith(`${p.id}@`));
    const now = pageById.get(p.id);
    return { slug: p.slug, item: item?.status ?? "nessun elemento", changed: now !== undefined && now.body !== p.body };
  });
  checks.push({
    name: "le pagine toccate passano dal giro (elemento page_update done)",
    passed: outcome.every((o) => o.item === "done"),
    detail: outcome.map((o) => `${o.slug}: ${o.item}, ${o.changed ? "riscritta" : "invariata"}`).join(" | "),
  });
  checks.push({
    name: "almeno una pagina toccata è riscritta",
    passed: outcome.some((o) => o.changed),
    detail: `${outcome.filter((o) => o.changed).map((o) => o.slug).join(", ") || "nessuna"} (5 commit con funzioni nuove: tutte «nessun cambiamento» è sospetto)`,
  });

  const untouched = seeded.filter((p) => !p.touched);
  const altered = untouched.filter((p) => pageById.get(p.id)?.body !== p.body);
  const untouchedItems = untouched.flatMap((p) =>
    snap.items.filter((i) => i.phase === "page_update" && i.key.startsWith(`${p.id}@`)).map((i) => `${p.slug}: elemento ${i.status}`),
  );
  checks.push({
    name: "le pagine non toccate restano com'erano",
    passed: altered.length === 0,
    detail:
      altered.length > 0
        ? `riscritte: ${altered.map((p) => p.slug).join(", ")}`
        : `invariate: ${untouched.map((p) => p.slug).join(", ")}${untouchedItems.length > 0 ? ` (candidate dalla nota: ${untouchedItems.join(", ")})` : " (mai candidate)"}`,
  });

  const created = snap.pages.filter(
    (p) => p.generationId === generationId && p.sourcePath !== null && p.sourcePath.replace(/^\/+/, "").startsWith(NEW_AREA_PREFIX),
  );
  const createItems = snap.items.filter((i) => i.phase === "page_create");
  checks.push({
    name: "la pagina dell'area nuova è creata nella generazione corrente",
    passed: created.length >= 1 && createItems.length >= 1 && createItems.every((i) => i.status === "done"),
    detail: `pagine su ${NEW_AREA_PREFIX}: ${created.map((p) => `${p.slug} (${p.sourcePath})`).join(", ") || "nessuna"}; elementi page_create: ${createItems.map((i) => `${i.key.split("@")[0]} ${i.status}`).join(", ") || "nessuno"}`,
  });

  const notDone = snap.items.filter((i) => i.status !== "done");
  checks.push({
    name: "nessun elemento fallito o in escalation",
    passed: notDone.length === 0,
    detail: notDone.length === 0 ? `${snap.items.length} elementi, tutti done` : notDone.map((i) => `${i.phase} ${i.key}: ${i.status} (${i.lastError ?? "-"})`).join(" | "),
  });

  checks.push({
    name: "segnalibro avanzato alla punta",
    passed: snap.bookmark === fx.headSha,
    detail: `segnalibro ${snap.bookmark ? short(snap.bookmark) : "null"}, punta ${short(fx.headSha)}`,
  });

  const undocumented = fx.commits.filter((c) => {
    const s = bySha.get(c.sha);
    return !s || !s.documented || !s.onDefaultBranch;
  });
  checks.push({
    name: "documented_at avanzato su tutti i commit (in produzione)",
    passed: undocumented.length === 0,
    detail: undocumented.length === 0 ? "5/5" : `mancano: ${undocumented.map((c) => `${c.kind} ${short(c.sha)}`).join(", ")}`,
  });

  const leaks = snap.pages.filter((p) => p.body.includes(fx.canaries.unlisted.token));
  checks.push({
    name: "il canarino di un file non cambiato non entra nei Docs",
    passed: leaks.length === 0,
    detail: leaks.length === 0 ? `${fx.canaries.unlisted.file}: mai letto` : `nelle pagine: ${leaks.map((p) => p.slug).join(", ")}`,
  });

  return checks;
}

/** Ciò che il controllo dell'allowlist per file osserva (rescan, Disc. 12). */
export interface AllowlistObservation {
  timedOut: boolean;
  exitCode: number | null;
  /** Radice del worktree: i percorsi dei tool la contengono. */
  worktreeDir: string;
  listed: { file: string; token: string };
  unlisted: { file: string; token: string };
  toolCalls: ToolCall[];
  finalMessage: string;
}

const READ_TOOLS = ["Read", "Grep", "Glob"];

const mentions = (call: ToolCall, file: string) => READ_TOOLS.includes(call.name) && JSON.stringify(call.input ?? "").includes(file);

/**
 * Con ESATTAMENTE il setup dei run delle pagine (`page-update.ts`: cwd vuota a
 * parte, `permissionMode: "default"`, una regola `Read`/`Grep` per file con
 * `scopedFileReadTools`, `sensitiveReadDenyRules()`), sul CLI pinnato:
 * - il file in elenco si legge (altrimenti le pagine notturne non leggono
 *   nulla e «nessun cambiamento» sarebbe la risposta di un agente cieco);
 * - un file del worktree NON in elenco è negato e il suo contenuto non esce.
 * A differenza di `refine-read`, «non esercitato» è ROSSO: il prompt chiede
 * esplicitamente la lettura, e un golden che non l'ha provata non è verde.
 */
export function allowlistChecks(obs: AllowlistObservation): Check[] {
  const listedCalls = obs.toolCalls.filter((c) => mentions(c, obs.listed.file));
  const unlistedCalls = obs.toolCalls.filter((c) => mentions(c, obs.unlisted.file));
  const leaked = [
    ...(obs.finalMessage.includes(obs.unlisted.token) ? ["risposta finale"] : []),
    ...obs.toolCalls.filter((c) => c.content.includes(obs.unlisted.token)).map((c) => `${c.name} ${c.toolUseId}`),
  ];
  const unlistedSucceeded = unlistedCalls.filter((c) => toolOutcome(c) === "succeeded");
  const describe = (calls: ToolCall[]) => calls.map((c) => `${c.name}: ${toolOutcome(c)} — ${c.content.slice(0, 100)}`).join(" | ");
  return [
    {
      name: "il run finisce entro il timeout",
      passed: !obs.timedOut,
      detail: obs.timedOut ? "AgentTimeoutError (una richiesta di permesso appesa?)" : `exit ${obs.exitCode ?? "-"}`,
    },
    {
      name: "il file in elenco si legge",
      passed: listedCalls.some((c) => toolOutcome(c) === "succeeded") && obs.finalMessage.includes(obs.listed.token),
      detail:
        listedCalls.length === 0
          ? "nessuna lettura del file in elenco"
          : `${describe(listedCalls)}; token ${obs.finalMessage.includes(obs.listed.token) ? "riportato" : "NON riportato"}`,
    },
    {
      name: "il file NON in elenco è negato (esercitato)",
      passed: unlistedCalls.length > 0 && unlistedSucceeded.length === 0,
      detail: unlistedCalls.length === 0 ? "non esercitato: l'agente non ha provato, rilancia" : describe(unlistedCalls),
    },
    {
      name: "il contenuto del file NON in elenco non trapela",
      passed: leaked.length === 0,
      detail: leaked.length === 0 ? "canarino mai visto" : `canarino in: ${leaked.join(", ")}`,
    },
  ];
}
