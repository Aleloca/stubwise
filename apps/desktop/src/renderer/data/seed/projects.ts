import { TEMPLATE_MODULES } from "../../domain/templates";
import type { Project, ProjectTemplate } from "../types";
import { CLAUDE_ID, PEOPLE } from "./people";

type Row = [code: string, name: string, clientName: string | undefined, template: ProjectTemplate];

// Aziende inventate: nessun cliente reale. Gli unici nomi veri sono i due
// prodotti interni, Stubwise e Audin.
const ROWS: Row[] = [
  ["STW", "Stubwise", undefined, "software"],
  ["AUD", "Audin 2.0", undefined, "software"],
  ["MKX", "Campagne primavera Mix Cucine", "Mix Cucine Srl", "marketing"],
  ["CBV", "Store online Cantina Bellavista", "Cantina Bellavista Srl", "client"],
  ["FRL", "Ordini online Forneria Rossi & Lari", "Forneria Rossi & Lari", "client"],
  ["OLV", "Sito vetrina Oleificio Valdarno", "Oleificio Valdarno", "marketing"],
  ["TLM", "Portale B2B Tessitura Lombarda Mori", "Tessitura Lombarda Mori Spa", "software"],
  ["CAL", "Catalogo Calzaturificio Alpi Lunghe", "Calzaturificio Alpi Lunghe", "client"],
  ["BRN", "Shop Birrificio Rio Nero", "Birrificio Rio Nero Srl", "client"],
  ["PSF", "Area rivenditori Pastificio San Fedele", "Pastificio San Fedele", "software"],
  [
    "CVP",
    "Portale soci Consorzio Agrario Valli Padane",
    "Consorzio Agrario Valli Padane",
    "software",
  ],
  ["LMR", "Brand refresh Lanificio Marzotti Rinaldi", "Lanificio Marzotti Rinaldi", "marketing"],
  ["GLT", "Rete franchising Gelateria Lago Tondo", "Gelateria Lago Tondo Srl", "client"],
  ["ELS", "Configuratore Elettrosistemi Sabbia", "Elettrosistemi Sabbia Spa", "software"],
  ["VDM", "Newsletter Vini del Monferrato", "Vini del Monferrato Soc. Coop.", "marketing"],
  ["AGR", "Prenotazioni Agriturismo Rocca Verde", "Agriturismo Rocca Verde", "client"],
  ["MBL", "Showroom Mobilificio Brianza Lecco", "Mobilificio Brianza Lecco", "client"],
  ["CRT", "Gestionale ordini Cartiera del Torrente", "Cartiera del Torrente Spa", "software"],
  ["IDR", "Assistenza clienti Idrotermica Ponente", "Idrotermica Ponente Srl", "client"],
  ["SAL", "Sito e catalogo Salumificio Altopiano", "Salumificio Altopiano", "marketing"],
  ["FER", "E-commerce Ferramenta Ceresio", "Ferramenta Ceresio Snc", "client"],
  ["BTG", "Campagne social Bottega dei Grigioni", "Bottega dei Grigioni", "marketing"],
  ["ACQ", "Portale utenti Acquedotto delle Colline", "Acquedotto delle Colline Spa", "software"],
  ["NVS", "Biglietteria Navigazione Lago Sereno", "Navigazione Lago Sereno", "software"],
  ["TPL", "Preventivatore Tipografia Pellico", "Tipografia Pellico Srl", "client"],
  ["CMA", "Sito Carpenteria Monti Alti", "Carpenteria Monti Alti", "marketing"],
  ["ORF", "Catalogo gioielli Orafi Valenza", "Orafi Valenza Srl", "client"],
  ["PVN", "Configuratore Pavimenti Nordest", "Pavimenti Nordest Spa", "software"],
  ["ZNC", "Intranet Zuccherificio Nuova Capanna", "Zuccherificio Nuova Capanna", "software"],
  ["LGS", "Tracking Logistica Sud Appennino", "Logistica Sud Appennino Srl", "software"],
  ["CNF", "Shop Confetteria Dolce Fiore", "Confetteria Dolce Fiore", "client"],
  ["SPT", "Sito professionale Studio Pittaluga", "Studio Pittaluga & Associati", "marketing"],
  ["HTL", "Booking engine Hotel Belvedere Lago", "Hotel Belvedere Lago Srl", "client"],
  ["MTC", "Portale clienti Metalcostruzioni Carso", "Metalcostruzioni Carso", "client"],
  ["VTR", "Shop Vetreria Artigiana Tre Ponti", "Vetreria Artigiana Tre Ponti", "client"],
  ["EDL", "Area riservata Edilizia Lariana", "Edilizia Lariana Spa", "client"],
  ["FLR", "Catalogo B2B Florovivaismo Riviera", "Florovivaismo Riviera", "software"],
  ["CST", "Campagne stagionali Caseificio Sant'Orso", "Caseificio Sant'Orso", "marketing"],
  ["TSM", "Ticketing Termoservizi Mantovana", "Termoservizi Mantovana Srl", "software"],
  ["BCC", "Configuratore Biciclette Corsa Colli", "Biciclette Corsa Colli", "client"],
  ["PRF", "Programma fedeltà Profumeria Rosa Antica", "Profumeria Rosa Antica", "client"],
  ["AQM", "Sito Acque Minerali Monteverde", "Acque Minerali Monteverde", "marketing"],
  ["SDR", "Appuntamenti Sartoria Duca Reale", "Sartoria Duca Reale", "client"],
  ["GRP", "Web-to-print Grafiche Padane", "Grafiche Padane Srl", "software"],
  ["MLN", "Ordini rivenditori Mulino Nobile", "Mulino Nobile Spa", "client"],
  ["CFM", "Abbonamenti Torrefazione Monforte", "Torrefazione Monforte", "client"],
  ["RST", "Prenotazioni Ristorante Sapori Tersi", "Sapori Tersi Srl", "client"],
  ["UFF", "Pratiche Fiduciaria Ardeatina", "Fiduciaria Ardeatina Srl", "empty"],
  ["TRM", "Portale autisti Trasporti Maremma", "Trasporti Maremma Srl", "software"],
  ["VLC", "Configuratore tetti Valcamonica Legnami", "Valcamonica Legnami Spa", "client"],
];

// Progetti fissati da Giulia Ferri (marketing, utente di default). I primi
// cinque di `GIULIA_LEAD_CODES` sono quelli su cui è Project Lead.
export const GIULIA_PINNED_CODES = [
  "MKX",
  "AUD",
  "STW",
  "CBV",
  "OLV",
  "LMR",
  "VDM",
  "SAL",
  "BTG",
  "CMA",
  "CST",
  "SPT",
  "AQM",
  "FRL",
] as const;
export const GIULIA_LEAD_CODES = ["MKX", "OLV", "LMR", "VDM", "SAL"] as const;

/**
 * Membri dei tre progetti di riferimento, scritti a mano: sono quelli su cui
 * si provano la visibilità (Sara non vede AUD né MKX) e le pagine ricche.
 */
const REFERENCE_MEMBERS: Record<string, string[]> = {
  STW: [
    "p-giulia",
    "p-marco",
    "p-laura",
    "p-simone",
    "p-federico",
    "p-sara",
    "p-davide",
    "p-elena",
  ],
  AUD: ["p-giulia", "p-marco", "p-laura", "p-alessia", "p-stefano", "p-matteo", "p-elena"],
  MKX: ["p-giulia", "p-elena", "p-paolo", "p-chiara", "p-tommaso", "p-matteo", "p-francesca"],
};

/** I progetti fissati di partenza di ogni personaggio del «vedi come». */
export const INITIAL_PINNED_CODES: Record<string, readonly string[]> = {
  "p-giulia": GIULIA_PINNED_CODES,
  "p-marco": ["STW", "AUD", "TLM", "PSF", "CVP", "ELS", "CRT", "ACQ"],
  "p-laura": ["AUD", "STW", "ELS", "CRT", "ACQ", "NVS", "PVN"],
  "p-sara": ["STW", "CBV", "TLM", "PSF", "GLT", "IDR"],
  "p-roberta": ["STW", "AUD", "MKX", "CBV", "ACQ", "UFF"],
};

const NON_CLAUDE = PEOPLE.filter((p) => !p.isClaude);

export const PROJECTS: Project[] = ROWS.map(([code, name, clientName, template], i) => {
  const memberIds = new Set<string>(REFERENCE_MEMBERS[code]);
  if (!REFERENCE_MEMBERS[code]) {
    for (let k = 0; k < 5; k++) memberIds.add(NON_CLAUDE[(i * 3 + k * 7) % NON_CLAUDE.length]!.id);
    if ((GIULIA_PINNED_CODES as readonly string[]).includes(code)) memberIds.add("p-giulia");
    if (template === "software") {
      memberIds.add("p-marco");
      memberIds.add("p-laura");
    }
    if (i % 3 === 0) memberIds.add("p-sara");
  }
  if (template === "software" || i % 4 === 0 || code === "MKX") memberIds.add(CLAUDE_ID);
  const project: Project = {
    id: `prj-${code.toLowerCase()}`,
    code,
    name,
    kind: clientName ? "client" : "internal",
    template,
    modules: [...TEMPLATE_MODULES[template]],
    memberIds: [...memberIds],
    // Soglie di default (7 / 14 giorni); AUD le ha più larghe, per provarle.
    stallThresholds:
      code === "AUD" ? { activeDays: 10, todoDays: 21 } : { activeDays: 7, todoDays: 14 },
    signals: { claudeWorking: template === "software" && i % 2 === 0 },
  };
  if (clientName) project.clientName = clientName;
  // Il tetto delle correzioni automatiche per PR: STW lo fissa a tre.
  if (code === "STW") project.correctionCap = 3;
  return project;
});
