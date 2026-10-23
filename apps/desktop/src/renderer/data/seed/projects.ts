import type { Project, ProjectModule, ProjectTemplate } from "../types";
import { CLAUDE_ID, PEOPLE } from "./people";

const MODULES: Record<ProjectTemplate, ProjectModule[]> = {
  software: ["docs", "releases", "support", "servers"],
  marketing: ["docs", "support"],
  client: ["docs", "releases", "support"],
  empty: [],
};

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

const NON_CLAUDE = PEOPLE.filter((p) => !p.isClaude);

export const PROJECTS: Project[] = ROWS.map(([code, name, clientName, template], i) => {
  const memberIds = new Set<string>();
  for (let k = 0; k < 5; k++) memberIds.add(NON_CLAUDE[(i * 3 + k * 7) % NON_CLAUDE.length]!.id);
  if ((GIULIA_PINNED_CODES as readonly string[]).includes(code)) memberIds.add("p-giulia");
  if (template === "software") memberIds.add("p-marco");
  if (template === "software" || i % 4 === 0) memberIds.add(CLAUDE_ID);
  if (i % 3 === 0) memberIds.add("p-sara");
  const project: Project = {
    id: `prj-${code.toLowerCase()}`,
    code,
    name,
    kind: clientName ? "client" : "internal",
    template,
    modules: [...MODULES[template]],
    memberIds: [...memberIds],
    signals: {
      waitingOnViewer: i % 7 === 0,
      claudeWorking: template === "software" && i % 2 === 0,
    },
  };
  if (clientName) project.clientName = clientName;
  return project;
});
