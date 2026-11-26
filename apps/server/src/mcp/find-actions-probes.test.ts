import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { catalogEntries, createRouteCollector, type CatalogEntry } from "./catalog.js";

/**
 * La controprova del lotto 7 con l'inventario dell'app
 * (`docs/plans/2026-11-26-mcp-parita-inventario.md`): frasi come le scrive chi
 * chiede, in italiano e in inglese, contro il catalogo VERO e la ricerca VERA
 * di `find_actions` (`rankActions` del pacchetto, importato per percorso come
 * in `lotto-fixtures.test.ts`). La voce attesa deve stare fra quelle che il
 * tool mostra. Una frase che non la trova si corregge nel sommario della
 * rotta, non qui.
 */
const ACTIONS = join(import.meta.dirname, "../../../../packages/mcp/src/tools/actions.ts");

interface Ranker {
  rankActions(catalog: readonly CatalogEntry[], query: string[]): { action: string }[];
  words(text: string): string[];
}

const PROBES: readonly [phrase: string, action: string][] = [
  ["eventi del calendario", "calendar.range"],
  ["calendar events", "calendar.range"],
  ["prossimi appuntamenti", "calendar.range"],
  ["sincronizza la posta", "google.syncNow"],
  ["sincronizza il calendario", "google.syncNow"],
  ["sync mailbox", "google.syncNow"],
  ["cerca nella posta", "mail.threads"],
  ["search mail", "mail.threads"],
  ["progetti fissati", "me.follows"],
  ["fissa un progetto", "me.setFollows"],
  // «pin project» no: ogni voce `projects.*` vale già 3 su «project» (limite noto).
  ["segui un progetto", "me.setFollows"],
  ["soglie di allarme del server", "servers.update"],
  ["server thresholds", "servers.update"],
  ["rilancia con istruzioni", "tickets.runAi"],
  ["riprendi la correzione", "tickets.runAi"],
  ["notifiche", "inbox.list"],
  ["inbox", "inbox.list"],
  ["task nate da una mail", "calendar.meetingTasks"],
  ["modifica reparto", "departments.update"],
  ["pipeline di rilascio del repository", "repositories.update"],
  ["modalità PR del repository", "repositories.update"],
  ["cronologia del progetto", "projects.chronology"],
  ["attività della task", "tasks.activity"],
  ["automazioni del progetto", "automations.ofProject"],
  ["webhook", "settings.webhooks"],
  ["list webhooks", "settings.webhooks"],
  ["modelli AI", "settings.models"],
  ["app Google", "settings.googleWorkspaces"],
  ["sposta la task a giovedì", "tasks.update"],
  ["approva il piano", "tickets.approvePlan"],
  ["manda la bozza", "mail.send"],
];

describe("find_actions trova le azioni dell'app con le parole di chi chiede", async () => {
  const { rankActions, words } = (await import(pathToFileURL(ACTIONS).href)) as Ranker;
  const collector = createRouteCollector();
  const app = buildApp({ onRoute: collector.hook });
  await app.ready();
  await app.close();
  const catalog = catalogEntries(collector.routes());

  it("ogni voce attesa esiste nel catalogo", () => {
    const names = new Set(catalog.map((e) => e.action));
    expect(PROBES.map(([, a]) => a).filter((a) => !names.has(a))).toEqual([]);
  });

  it.each(PROBES)("«%s» trova %s", (phrase, action) => {
    const shown = rankActions(catalog, words(phrase)).map((e) => e.action);
    expect(shown).toContain(action);
  });
});
