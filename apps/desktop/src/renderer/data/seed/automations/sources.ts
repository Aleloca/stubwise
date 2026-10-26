// Le sorgenti delle Automations (area 7): Audin collegato con tre trattative
// chiuse, HubSpot scaduto, un webhook in arrivo; più la tabella cliente →
// progetto con cui un'automazione generale trova il progetto dai dati
// dell'evento. Clienti inventati, domini `.example`.
import type { AutomationSource, ClientProjectLink, DataField } from "../../types";
import { daysFromToday } from "../dates";

export const SOURCE_AUDIN = "src-audin";
export const SOURCE_HUBSPOT = "src-hubspot";
export const SOURCE_WEBHOOK = "src-webhook";

/** I dati di una trattativa chiusa, uguali per Audin e HubSpot. */
const DEAL_FIELDS: DataField[] = [
  { key: "trattativa.id", label: "ID trattativa", type: "text" },
  { key: "trattativa.titolo", label: "Trattativa", type: "text" },
  { key: "trattativa.importo", label: "Importo", type: "number" },
  { key: "trattativa.chiusaIl", label: "Chiusa il", type: "date" },
  { key: "trattativa.commerciale", label: "Commerciale", type: "person" },
  {
    key: "trattativa.prodotti",
    label: "Prodotti venduti",
    type: "list",
    of: [
      { key: "nome", label: "Prodotto", type: "text" },
      { key: "quantita", label: "Quantità", type: "number" },
    ],
  },
  { key: "trattativa.contratto", label: "Contratto", type: "file" },
  { key: "cliente.nome", label: "Cliente", type: "text" },
  { key: "cliente.email", label: "Email del cliente", type: "email" },
  { key: "cliente.dominio", label: "Dominio del cliente", type: "text" },
];

interface DealSpec {
  id: string;
  client: string;
  email: string;
  domain: string;
  amount: number;
  closedDaysAgo: number;
  products: [string, number][];
  /** I punti del contratto da cui Claude ricava le task. */
  clauses: string[];
}

function contractText(d: DealSpec): string {
  return [
    `CONTRATTO DI FORNITURA N. ${d.id}`,
    `Tra Audin S.r.l. (il Fornitore) e ${d.client} (il Cliente).`,
    `1. Oggetto. Il Fornitore attiva per il Cliente: ${d.products
      .map(([name, qty]) => `${name} (${qty})`)
      .join(", ")}.`,
    ...d.clauses.map((c, i) => `${i + 2}. ${c}`),
    `${d.clauses.length + 2}. Corrispettivo. ${d.amount} euro annui, fatturati in anticipo.`,
    `${d.clauses.length + 3}. Durata. Dodici mesi dalla firma, con rinnovo tacito.`,
  ].join("\n");
}

function deal(d: DealSpec): Record<string, unknown> {
  return {
    trattativa: {
      id: d.id,
      titolo: `${d.products.map(([name]) => name).join(" + ")} – ${d.client}`,
      importo: d.amount,
      chiusaIl: daysFromToday(-d.closedDaysAgo),
      commerciale: "p-elena",
      prodotti: d.products.map(([nome, quantita]) => ({ nome, quantita })),
      contratto: {
        nome: `Contratto ${d.id}.pdf`,
        tipo: "pdf",
        testo: contractText(d),
      },
    },
    cliente: { nome: d.client, email: d.email, dominio: d.domain },
  };
}

/** Le tre trattative chiuse di Audin: la prima e la seconda hanno il cliente in tabella, la terza no. */
const AUDIN_DEALS: DealSpec[] = [
  {
    id: "AUD-TR-1042",
    client: "Cantina Bellavista Srl",
    email: "amministrazione@cantinabellavista.example",
    domain: "cantinabellavista.example",
    amount: 18400,
    closedDaysAgo: 12,
    products: [
      ["CRM", 8],
      ["Centralino AI", 1],
    ],
    clauses: [
      "Migrazione dei contatti. Il Fornitore importa nel CRM l'anagrafica clienti esportata dal gestionale del Cliente entro 15 giorni dalla firma.",
      "Formazione. Due sessioni da due ore per gli otto utenti del CRM.",
      "Centralino. Il Fornitore configura il Centralino AI sui due numeri della cantina, con orari di apertura e messaggio di benvenuto forniti dal Cliente.",
      "Fatturazione. Il primo canone si fattura all'attivazione.",
    ],
  },
  {
    id: "AUD-TR-1057",
    client: "Mix Cucine Srl",
    email: "marketing@mixcucine.example",
    domain: "mixcucine.example",
    amount: 6200,
    closedDaysAgo: 5,
    products: [["Campagne WhatsApp", 1]],
    clauses: [
      "Numero WhatsApp Business. Il Cliente mette a disposizione un numero dedicato e il Fornitore ne cura la verifica.",
      "Contatti. Il Cliente fornisce l'elenco dei contatti con il consenso al marketing; il Fornitore ne controlla il formato.",
      "Modelli. Il Fornitore prepara tre modelli di messaggio da sottoporre all'approvazione di Meta.",
    ],
  },
  {
    id: "AUD-TR-1063",
    client: "Forneria Rossi & Lari",
    email: "ordini@forneriarossilari.example",
    domain: "forneriarossilari.example",
    amount: 9900,
    closedDaysAgo: 1,
    products: [
      ["CRM", 3],
      ["Campagne WhatsApp", 1],
      ["Preventivi online", 1],
    ],
    clauses: [
      "CRM. Tre utenti, con la pipeline degli ordini all'ingrosso.",
      "Campagne. Una campagna mensile di promozioni ai rivenditori.",
      "Preventivi. Il catalogo dei prodotti da forno viene caricato dal Fornitore a partire dal listino in PDF del Cliente.",
      "Fatturazione. Il primo canone si fattura all'attivazione.",
    ],
  },
];

export const AUDIN_SAMPLE_EVENTS = AUDIN_DEALS.map(deal);

/** I dati del modulo di attivazione dal sito: chi chiede e cosa serve per attivare. */
const WEBHOOK_FIELDS: DataField[] = [
  { key: "cliente.nome", label: "Cliente", type: "text" },
  { key: "cliente.email", label: "Email del cliente", type: "email" },
  { key: "richiesta.funzione", label: "Funzione da attivare", type: "text" },
  { key: "richiesta.dati", label: "Dati da chiedere al cliente", type: "text" },
];

export const WEBHOOK_SAMPLE_EVENTS: Record<string, unknown>[] = [
  {
    cliente: { nome: "Cantina Bellavista Srl", email: "amministrazione@cantinabellavista.example" },
    richiesta: {
      funzione: "Centralino AI",
      dati: "I due numeri da collegare, gli orari di apertura e il testo del messaggio di benvenuto.",
    },
  },
  {
    cliente: { nome: "Mix Cucine Srl", email: "marketing@mixcucine.example" },
    richiesta: {
      funzione: "Campagne WhatsApp",
      dati: "Il numero WhatsApp Business, il logo in alta risoluzione e l'elenco dei contatti con il consenso.",
    },
  },
];

export const AUTOMATION_SOURCES: AutomationSource[] = [
  {
    id: SOURCE_AUDIN,
    kind: "audin",
    name: "Audin",
    status: "connected",
    connectedById: "p-roberta",
    sampleEvents: AUDIN_SAMPLE_EVENTS,
    fields: DEAL_FIELDS,
  },
  {
    id: SOURCE_HUBSPOT,
    kind: "hubspot",
    name: "HubSpot",
    status: "expired",
    connectedById: "p-roberta",
    sampleEvents: [
      deal({
        id: "HS-88213",
        client: "Tessitura Lombarda Mori Spa",
        email: "it@tessituramori.example",
        domain: "tessituramori.example",
        amount: 24000,
        closedDaysAgo: 41,
        products: [["CRM", 15]],
        clauses: [
          "Integrazione. Il CRM si collega al portale B2B del Cliente per leggere gli ordini dei rivenditori.",
          "Formazione. Una sessione per reparto commerciale.",
        ],
      }),
    ],
    fields: DEAL_FIELDS,
  },
  {
    id: SOURCE_WEBHOOK,
    kind: "webhook",
    name: "Modulo di attivazione dal sito",
    status: "connected",
    connectedById: "p-roberta",
    sampleEvents: WEBHOOK_SAMPLE_EVENTS,
    fields: WEBHOOK_FIELDS,
  },
];

/**
 * Cliente → progetto. Mix Cucine porta a MKX, che Sara non vede; Forneria
 * Rossi & Lari (la terza trattativa di Audin) manca apposta: la sua
 * esecuzione aspetta che il proprietario scelga il progetto.
 */
export const CLIENT_PROJECT_LINKS: ClientProjectLink[] = [
  {
    clientKey: "cantinabellavista.example",
    clientName: "Cantina Bellavista Srl",
    projectId: "prj-cbv",
  },
  { clientKey: "mixcucine.example", clientName: "Mix Cucine Srl", projectId: "prj-mkx" },
  {
    clientKey: "tessituramori.example",
    clientName: "Tessitura Lombarda Mori Spa",
    projectId: "prj-tlm",
  },
];
