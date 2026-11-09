import type { AiOperation } from "@stubwise/shared";
import type { UsageRecord } from "../instance/state";
import { CONVERSATIONS } from "./conversations";
import { TODAY, daysFromToday } from "./dates";
import { hashOf, seededRandom } from "./servers/metrics";

// Il seme dei consumi d'istanza (area 9b): 90 giorni, deterministici. Una
// voce per ogni modello di ogni sessione di lavoro di `seed/runs.ts` (con le
// sue cifre), più voci sintetiche per le operazioni di tutti i giorni: il
// giro notturno, i report, la classificazione della posta, la chat e il
// lavoro dei ticket. Il mese in corso sta sotto il budget del seme (600 $):
// le voci sintetiche si scalano perché lo speso arrivi a ~410 $.

/** Lo speso del mese in corso, a cui il seme mira. */
const TARGET_MONTH_USD = 410;
const DAYS = 90;
const NOW = `${TODAY}T12:00:00Z`;

const SONNET = "claude-sonnet-4-5";
const OPUS = "claude-opus-4-5";
const HAIKU = "claude-haiku-4-5";
const TEAM = "prv-team-max";
const BACKUP = "prv-backup-max";
const BILLING = "prv-billing-key";

/** I progetti su cui gira il lavoro sintetico, i più attivi per primi. */
const PROJECTS = ["prj-stw", "prj-aud", "prj-mkx", "prj-cbv", "prj-acq", "prj-tlm", "prj-frl"];

const PROVIDER_BY_NAME: Record<string, string> = { "Team Max": TEAM, "Billing key": BILLING };

type Draft = Omit<UsageRecord, "id">;

/** Le voci delle sessioni di lavoro: le cifre sono quelle di `ModelUsage`. */
function sessionRecords(): Draft[] {
  const out: Draft[] = [];
  for (const c of CONVERSATIONS) {
    if (!c.usage || c.usage.length === 0) continue;
    const providerId = c.provider?.id ?? PROVIDER_BY_NAME[c.provider?.name ?? ""] ?? TEAM;
    for (const u of c.usage) {
      out.push({
        at: c.updatedAt,
        operation: c.kind === "refine" ? "backlog_refine" : "fix_execute",
        model: u.model,
        projectId: c.projectId,
        providerId,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        costUsd: u.costUsd,
        conversationId: c.id,
      });
    }
  }
  return out;
}

/** Quanto pesa il giorno: i fine settimana lavorano poco. */
function weekdayFactor(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6 ? 0.3 : 1;
}

const hm = (hour: number, minute: number): string =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;

/** Le voci sintetiche di un giorno, a costo grezzo (si scala dopo). */
function dayRecords(date: string, rnd: () => number): Draft[] {
  const factor = weekdayFactor(date);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const between = (lo: number, hi: number): number => lo + rnd() * (hi - lo);
  const out: Draft[] = [];
  const add = (
    time: string,
    operation: AiOperation,
    model: string,
    projectId: string | null,
    providerId: string,
    cost: number,
  ): void => {
    out.push({
      at: `${date}T${time}`,
      operation,
      model,
      projectId,
      providerId,
      inputTokens: Math.round(cost * between(90_000, 130_000)),
      outputTokens: Math.round(cost * between(7_000, 12_000)),
      cacheReadTokens: model === HAIKU ? 0 : Math.round(cost * between(220_000, 320_000)),
      costUsd: cost,
      conversationId: null,
    });
  };

  // Il giro notturno (02:00 di Roma): riassunti dei commit e, a giorni, i Docs.
  add(hm(0, 10), "commit_summary", HAIKU, pick(PROJECTS), TEAM, between(0.3, 0.9));
  if (rnd() < 0.6) add(hm(0, 40), "docs_nightly", SONNET, pick(PROJECTS), TEAM, between(3, 9));
  if (rnd() < 0.3) add(hm(1, 20), "release_notes", SONNET, pick(PROJECTS), TEAM, between(0.5, 1.5));
  // I report del giorno chiuso.
  for (const p of PROJECTS.slice(0, 3))
    add(hm(1, 40), "daily_report", HAIKU, p, TEAM, between(0.05, 0.15));
  if (new Date(`${date}T00:00:00Z`).getUTCDay() === 1)
    add(hm(6, 0), "weekly_brief", SONNET, pick(PROJECTS), TEAM, between(1, 2.5));
  // La posta si classifica a ondate, senza progetto.
  for (const h of [8, 10, 14])
    add(hm(h, 5), "mail_classify", HAIKU, null, TEAM, between(0.02, 0.08));

  // Il lavoro dei ticket e la chat: solo nei giorni in cui si lavora.
  const jobs = Math.round(between(2, 5) * factor);
  for (let i = 0; i < jobs; i++) {
    const project = pick(PROJECTS);
    const provider = pick([TEAM, TEAM, TEAM, BILLING, BACKUP]);
    const h = 8 + i * 2;
    add(hm(h, 15), "triage", HAIKU, project, TEAM, between(0.05, 0.2));
    add(hm(h, 30), "fix_plan", OPUS, project, provider, between(1.5, 4));
    add(hm(h + 1, 0), "fix_execute", SONNET, project, provider, between(2, 9));
    if (rnd() < 0.7) add(hm(h + 1, 40), "pr_review", SONNET, project, TEAM, between(0.4, 1.2));
  }
  const chats = Math.round(between(1, 4) * factor);
  for (let i = 0; i < chats; i++)
    add(
      hm(9 + i * 2, 45),
      "chat",
      SONNET,
      rnd() < 0.8 ? pick(PROJECTS) : null,
      TEAM,
      between(0.4, 2.2),
    );
  return out;
}

const round = (x: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(x * k) / k;
};

/** I consumi del seme, in ordine di tempo, con gli id fissi. */
export function seedUsage(): UsageRecord[] {
  const sessions = sessionRecords();
  const synthetic: Draft[] = [];
  for (let d = -(DAYS - 1); d <= 0; d++) {
    const date = daysFromToday(d);
    synthetic.push(...dayRecords(date, seededRandom(hashOf(`usage|${date}`))));
  }
  const month = TODAY.slice(0, 7);
  const sum = (xs: Draft[]) => xs.reduce((a, r) => a + r.costUsd, 0);
  const inMonth = (r: Draft) => r.at.startsWith(month) && r.at <= NOW;
  const scale = (TARGET_MONTH_USD - sum(sessions.filter(inMonth))) / sum(synthetic.filter(inMonth));
  const all = [
    ...sessions,
    ...synthetic
      .filter((r) => r.at <= NOW)
      .map((r) => ({ ...r, costUsd: Math.max(0.01, round(r.costUsd * scale, 2)) })),
  ].sort(
    (a, b) =>
      a.at.localeCompare(b.at) || (a.conversationId ?? "").localeCompare(b.conversationId ?? ""),
  );
  return all.map((r, i) => ({ ...r, id: `usage-seed-${String(i + 1).padStart(4, "0")}` }));
}
