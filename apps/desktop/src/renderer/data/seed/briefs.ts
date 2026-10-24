import type { WeeklyBrief } from "../types";

// I brief settimanali dei progetti di riferimento: ESEMPI DI TESTO GENERATO
// (nel prodotto li scrive il worker con l'AI, il lunedì mattina, sulla
// settimana chiusa). Sono scritti a mano qui, ma hanno la voce di un
// riassunto generato: la UI li mostra sempre come «Generated text». Le
// quattro sezioni sono quelle di `projectBriefWeeklySchema.sections`.

interface Spec {
  code: string;
  /** Il lunedì della pubblicazione; il periodo è la settimana prima (lun–dom). */
  monday: string;
  whereWeAre: string;
  whatChanged: string;
  whatBlocks: string;
  whatWeNeed: string;
}

const SPECS: Spec[] = [
  {
    code: "AUD",
    monday: "2026-10-19",
    whereWeAre:
      "Public launch is four weeks out and most of the remaining work is in progress. Export and onboarding moved forward; the dashboard for large accounts is still the slowest part.",
    whatChanged:
      "- The timezone fix for scheduled callbacks shipped and closed.\n- The call history export started, with Claude working on it.\n- Billing emails with the new invoice layout were planned for next week.",
    whatBlocks:
      "- The CSV import waits for an answer to Claude's question about duplicate rules.\n- The dashboard speed-up has had no activity for almost two weeks.",
    whatWeNeed:
      "A decision on how duplicates are matched during import, and an owner check on the dashboard work before it slips again.",
  },
  {
    code: "AUD",
    monday: "2026-10-12",
    whereWeAre:
      "The private beta closed on time. The team is now on the public launch scope: onboarding, import and billing.",
    whatChanged:
      "- Pricing tiers for the launch were decided and the task closed.\n- The legacy SMS module was removed.",
    whatBlocks: "- Nothing blocking this week.",
    whatWeNeed: "Estimates for the launch announcement, which has none yet.",
  },
  {
    code: "STW",
    monday: "2026-10-19",
    whereWeAre:
      "The desktop prototype is due next week. The data layer that knows who is looking is done, and the board view is close; wording and help articles are the last pieces.",
    whatChanged:
      "- The viewer-aware fake data layer closed.\n- A crash at the minimum window size was reported and picked up.\n- Department homes started.",
    whatBlocks:
      "- The upgrade guide for self-hosted instances slipped twice and nobody touched it for over two weeks.\n- The wording of stalled reasons waits for Giulia's decision.",
    whatWeNeed:
      "Someone to own the release notes for the desktop preview, and a choice on the stalled-reason wording.",
  },
  {
    code: "STW",
    monday: "2026-10-12",
    whereWeAre:
      "Self-hosted 1.0 is out. Work moved to the desktop prototype, with planning across projects next.",
    whatChanged:
      "- The icon set for the rail was chosen.\n- The focus ring in the notifications panel was fixed.",
    whatBlocks: "- The upgrade guide slipped to this week.",
    whatWeNeed: "A size for the timeline view of planned weeks.",
  },
  {
    code: "MKX",
    monday: "2026-10-19",
    whereWeAre:
      "The spring campaign is on track for its date, with the media plan and the landing page copy in progress. The showroom event is still being shaped.",
    whatChanged:
      "- The campaign brief was approved and closed.\n- The leads report for the dealers was delivered.\n- Social posts for the showroom week were planned.",
    whatBlocks:
      "- The dealers' price list waits on the client to confirm the discounts.\n- The German landing page waits for the English copy.\n- Nobody is assigned to book the photographer.",
    whatWeNeed:
      "An answer on moving part of the April budget to social ads, and someone to book the photographer.",
  },
];

const minusOneDay = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** Il markdown intero del brief: le quattro sezioni con il loro titolo. */
function summaryOf(s: Spec): string {
  return [
    "## Where we are",
    s.whereWeAre,
    "## What changed",
    s.whatChanged,
    "## What's blocking",
    s.whatBlocks,
    "## What we need",
    s.whatWeNeed,
  ].join("\n\n");
}

export const BRIEFS: WeeklyBrief[] = SPECS.map((s) => ({
  id: `brief-${s.code.toLowerCase()}-${s.monday}`,
  projectId: `prj-${s.code.toLowerCase()}`,
  periodStart: minusOneDay(s.monday, 7),
  periodEnd: minusOneDay(s.monday, 1),
  headline: s.whereWeAre,
  summary: summaryOf(s),
  createdAt: `${s.monday}T07:00:00Z`,
}));
