import { t, type Language } from "@stubwise/i18n";
import type { BriefInput } from "./input.js";

/**
 * BRIEF SETTIMANALE (fase 5) — il prompt e il parse del suo output.
 *
 * È il terzo testo generato della fase, dopo i riassunti "in breve" di piano e
 * PR, e segue le loro due regole: la LINGUA non è cablata nel builder (sta nel
 * testo delle istruzioni, catalogo `brief.instructions`, già scritto nella
 * lingua di destinazione) e l'input è tutto NON FIDATO — titoli di ticket,
 * messaggi di commit riassunti dal report giornaliero, testo di decisioni scritte
 * da persone. Il run è `permissionMode "plan"` su una dir temporanea vuota: il
 * caso peggiore è un brief fuorviante in colonna, non un'azione.
 *
 * PERCHÉ I MARCATORI E NON IL JSON. Il brief è prosa lunga in quattro sezioni,
 * con elenchi e a capo: dentro un JSON ogni newline diventa `\n` da riscrivere,
 * e un modello che sbaglia una virgoletta fa perdere l'intero run. I marcatori
 * `<<WHERE>>`… costano un `split` e degradano bene: una sezione mancante è una
 * sezione vuota, non un parse fallito. Sono ASCII e UGUALI in ogni lingua — un
 * protocollo fra worker e agente, non testo da leggere.
 */

/** I marcatori di sezione richiesti all'agente. Non si traducono (vedi sopra). */
export const BRIEF_MARKERS = {
  whereWeAre: "<<WHERE>>",
  whatChanged: "<<CHANGED>>",
  whatBlocks: "<<BLOCKS>>",
  whatWeNeed: "<<NEED>>",
} as const;

/** Le quattro sezioni del brief, nell'ordine in cui si leggono. */
export type BriefSectionKey = keyof typeof BRIEF_MARKERS;

const SECTION_ORDER: BriefSectionKey[] = [
  "whereWeAre",
  "whatChanged",
  "whatBlocks",
  "whatWeNeed",
];

/** Il brief parsato: markdown completo più le sezioni separate. */
export interface BriefOutput {
  /** Markdown completo, coi titoli nella lingua dei contenuti. */
  summary: string;
  /** Le quattro sezioni. Una sezione mancante è `""`, mai assente. */
  sections: Record<BriefSectionKey, string>;
}

/**
 * Compone il prompt del brief. La struttura è neutra (etichette dei blocchi e
 * recinti ```), le istruzioni arrivano dal catalogo e portano con sé la lingua.
 *
 * Un blocco VUOTO viene reso comunque, col testo `brief.input.none`: dire
 * all'agente "questo dato non c'è" è diverso dal non parlargliene — la seconda
 * forma invita a riempire il vuoto, che è esattamente ciò che le regole del
 * prompt vietano.
 */
export function buildBriefPrompt(lang: Language, input: BriefInput): string {
  const blocks: { label: string; body: string }[] = [
    {
      label: t(lang, "brief.input.reports"),
      body: input.reports.map((r) => `${r.date}: ${r.summary}`).join("\n"),
    },
    { label: t(lang, "brief.input.timeline"), body: input.timeline.join("\n") },
    { label: t(lang, "brief.input.blocks"), body: input.blocks.join("\n") },
    { label: t(lang, "brief.input.decisions"), body: input.decisions.join("\n") },
    { label: t(lang, "brief.input.previous"), body: input.previousBrief ?? "" },
  ];

  const lines: string[] = [
    `Project: ${input.projectName}`,
    `Period: ${input.periodStart} → ${input.periodEnd}`,
    ``,
  ];
  for (const block of blocks) {
    lines.push(`${block.label}:`, "```", block.body.trim() || t(lang, "brief.input.none"), "```", ``);
  }
  if (input.truncated) lines.push(t(lang, "brief.input.truncated"), ``);
  lines.push(t(lang, "brief.instructions"));
  return lines.join("\n");
}

/**
 * Parsa l'output dell'agente nelle quattro sezioni e ne compone il markdown.
 *
 * DEGRADAZIONI, tutte volute:
 *  - una sezione senza marcatore è `""` e NON compare nel markdown (niente
 *    titoli orfani);
 *  - un preambolo prima del primo marcatore viene buttato;
 *  - un output SENZA nessun marcatore finisce tutto in "dove siamo": un brief
 *    monolitico è comunque leggibile, e con `whereWeAre` valorizzato la
 *    `headline` della notifica e della timeline esiste lo stesso;
 *  - un output vuoto è `null`: non c'è niente da salvare, e chi chiama lo
 *    tratta come il caso "provider assente" (brief `done`, `summary` NULL).
 */
export function parseBriefOutput(lang: Language, raw: string): BriefOutput | null {
  const text = raw.trim();
  if (text.length === 0) return null;

  const sections: Record<BriefSectionKey, string> = {
    whereWeAre: "",
    whatChanged: "",
    whatBlocks: "",
    whatWeNeed: "",
  };

  // Posizione di ogni marcatore presente, in ordine di apparizione: le sezioni
  // possono arrivare in un ordine diverso da quello chiesto, e non è un motivo
  // per buttare via il run.
  const found = SECTION_ORDER.map((key) => ({ key, at: text.indexOf(BRIEF_MARKERS[key]) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at);

  if (found.length === 0) {
    sections.whereWeAre = text;
  } else {
    found.forEach((entry, index) => {
      const start = entry.at + BRIEF_MARKERS[entry.key].length;
      const end = index + 1 < found.length ? found[index + 1]!.at : text.length;
      sections[entry.key] = text.slice(start, end).trim();
    });
  }

  const summary = SECTION_ORDER.filter((key) => sections[key].length > 0)
    .map((key) => `## ${t(lang, `brief.section.${key}` as const)}\n\n${sections[key]}`)
    .join("\n\n");

  return { summary, sections };
}
