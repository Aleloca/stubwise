import type { DriveFile, DriveOpen } from "../../types";
import { AUD_CLIENT_FOLDER as F } from "./google";
import { at, google, ready, spread, upload } from "./helpers";

// Audin 2.0: la cartella del cliente collegata da Matteo (contratto,
// preventivo, presentazioni, note) e i caricati del team (specifiche, mockup,
// un export .zip, un verbale scansionato). Il contratto (AUD-F7) è il file
// più aperto, e risponde a «quali sono i tempi di consegna?».

const MATTEO = "matteo.conti@example.com";
const GIULIA = "giulia.ferri@example.com";

export const ROADMAP_Q4_GOOGLE_ID = "gfile-roadmap-q4-2026";

const CONTRACT_TEXT = [
  "Framework agreement for Audin 2.0, between Audin (the Client) and the Audin 2.0 development team (the Supplier).",
  "1. Scope. The Supplier designs, builds and releases Audin 2.0: dialer, callbacks, CRM integration and billing, in releases agreed with the Client.",
  "2. Specifications. Each release starts from a written specification that the Client approves in writing.",
  "3. Delivery times. The Supplier delivers each release within 30 working days of the Client's written approval of its specification. Fixes to defects reported during acceptance are delivered within 5 working days. The go-live of the complete product is due by 31 March 2027.",
  "4. Late delivery. For each full week of delay beyond the delivery times above, the Client may apply a penalty of 0.5% of the release fee, capped at 5%. Delays caused by the Client (late approvals, missing access) extend the delivery times by the same amount.",
  "5. Acceptance. The Client has 10 working days from delivery to accept the release or report defects.",
  "6. Fees and invoicing. Each release is invoiced on acceptance; payment within 60 days.",
  "7. Term. The agreement lasts until 31 December 2027 and renews yearly unless cancelled with 90 days' notice.",
].join("\n\n");

export const AUD_FILES: DriveFile[] = [
  upload(
    "AUD",
    1,
    {
      name: "Kickoff Audin 2.0 – verbale firmato.pdf",
      type: "pdf",
      mime: "application/pdf",
      sizeBytes: 2_840_112,
      by: "p-laura",
      at: at(125, "18:02"),
    },
    ready(
      "Kickoff minutes, Audin 2.0. Attendees: Laura Costa, Matteo Conti, Marco Bellini, the Client. Agreed: monthly releases, dialer first, CRM integration in the second release. Signed by both parties.",
      "Signed kickoff minutes: monthly releases, dialer first, CRM integration in the second release.",
      true,
    ),
  ),
  upload(
    "AUD",
    2,
    {
      name: "Specifiche funzionali dialer v3.pdf",
      type: "pdf",
      mime: "application/pdf",
      sizeBytes: 1_204_533,
      by: "p-marco",
      at: at(130, "11:20"),
    },
    ready(
      "Functional specification of the dialer, version 3. Queues: agents take calls in order of priority, then waiting time. Callbacks: a missed call schedules a callback within 2 hours. Recording: on by default, can be paused for payment details.",
      "Functional spec of the dialer: queues, callbacks within 2 hours, recording rules.",
    ),
  ),
  upload(
    "AUD",
    3,
    {
      name: "mockup-dashboard-agenti.png",
      type: "image",
      mime: "image/png",
      sizeBytes: 486_220,
      by: "p-giulia",
      at: at(60, "15:44"),
    },
    ready(
      "Agents dashboard: Calls today 128, Waiting 4, Callbacks due 9, Average handling time 3:42.",
      "Mockup of the agents dashboard: calls, queue, callbacks due, handling time.",
    ),
  ),
  upload(
    "AUD",
    4,
    {
      name: "audin-design-export.zip",
      type: "other",
      mime: "application/zip",
      sizeBytes: 38_406_118,
      by: "p-giulia",
      at: at(58, "09:03"),
    },
    { content: "unsupported" },
  ),
  google(
    "AUD",
    5,
    { by: "p-giulia", at: at(40, "10:10") },
    {
      name: "Roadmap Q4 2026",
      type: "sheet",
      googleFileId: ROADMAP_Q4_GOOGLE_ID,
      owner: GIULIA,
      modified: at(3, "17:15"),
    },
    ready(
      "Q4 2026 roadmap. October: dialer callbacks, pricing page. November: CRM import, billing beta. December: Stubwise release queue, Audin 2.0 launch.",
      "Q4 2026 roadmap shared by Audin and Stubwise: dialer, CRM import, billing, launch.",
    ),
  ),
  google(
    "AUD",
    6,
    F,
    {
      name: "Note riunione cliente 12 ottobre",
      type: "document",
      googleFileId: "gfile-aud-note-1012",
      owner: MATTEO,
      modified: at(11, "13:30"),
    },
    ready(
      "Client meeting, 12 October. The Client asks to move the CRM import before billing. Agreed to review the release plan; no change to the delivery times in the contract.",
      "Client meeting notes: CRM import before billing, delivery times unchanged.",
    ),
  ),
  google(
    "AUD",
    7,
    F,
    {
      name: "Contratto quadro Audin 2025",
      type: "document",
      googleFileId: "gfile-aud-contratto-quadro",
      owner: MATTEO,
      modified: at(2, "09:48"),
    },
    ready(
      CONTRACT_TEXT,
      "Framework agreement: delivery within 30 working days of each approved specification, penalties capped at 5%, go-live by 31 March 2027.",
    ),
  ),
  google(
    "AUD",
    8,
    F,
    {
      name: "Presentazione Audin 2.0 – bozza superata",
      type: "slides",
      googleFileId: "gfile-aud-pres-bozza",
      owner: MATTEO,
      modified: at(110, "12:00"),
      hidden: true,
    },
    ready(
      "Early draft of the Audin 2.0 client presentation, replaced by the final version.",
      "Old draft of the client presentation, replaced by the final one.",
    ),
  ),
  google(
    "AUD",
    9,
    F,
    {
      name: "Preventivo licenze 2026",
      type: "sheet",
      googleFileId: "gfile-aud-preventivo-2026",
      owner: MATTEO,
      modified: at(5, "16:02"),
    },
    ready(
      "Quote for 40 seats with yearly billing: Team tier 40 × €29/month, onboarding €2,400 one-off, discount 10% on yearly payment.",
      "Quote for 40 seats with yearly billing and onboarding.",
    ),
  ),
  google(
    "AUD",
    10,
    F,
    {
      name: "Presentazione Audin 2.0 al cliente",
      type: "slides",
      googleFileId: "gfile-aud-pres-cliente",
      owner: MATTEO,
      modified: at(20, "10:12"),
    },
    ready(
      "Audin 2.0 for the Client: goals, the new dialer, callbacks, CRM integration, release plan and launch date.",
      "Client presentation of Audin 2.0: goals, dialer, CRM integration, release plan.",
    ),
  ),
  google(
    "AUD",
    11,
    F,
    {
      name: "Requisiti integrazione CRM cliente",
      type: "document",
      googleFileId: "gfile-aud-crm-req",
      owner: "it@audin-client.example",
      modified: at(30, "08:40"),
      unavailable: "deleted",
    },
    ready(
      "CRM integration requirements: contacts sync every 15 minutes, custom fields mapped by name.",
      "CRM integration requirements: 15-minute sync, custom fields by name.",
    ),
  ),
  upload(
    "AUD",
    12,
    {
      name: "mockup-callback-modal.png",
      type: "image",
      mime: "image/png",
      sizeBytes: 312_904,
      by: "p-giulia",
      at: at(1, "17:26"),
    },
    { content: "processing" },
  ),
  upload(
    "AUD",
    13,
    {
      name: "logo-audin-icona.png",
      type: "image",
      mime: "image/png",
      sizeBytes: 48_118,
      by: "p-giulia",
      at: at(45, "12:05"),
    },
    { content: "no_text" },
  ),
  google(
    "AUD",
    14,
    F,
    {
      name: "Calendario consegne – aggiornato",
      type: "sheet",
      googleFileId: "gfile-aud-calendario",
      owner: MATTEO,
      modified: at(0, "10:40"),
    },
    { content: "processing" },
  ),
  google(
    "AUD",
    15,
    { by: "p-matteo", at: at(50, "14:00") },
    {
      name: "Listino partner 2026.pdf",
      type: "pdf",
      mime: "application/pdf",
      sizeBytes: 902_311,
      googleFileId: "gfile-aud-listino-partner",
      owner: "sales@audin-client.example",
      modified: at(50, "13:50"),
      unavailable: "access_lost",
    },
    ready("Partner price list 2026.", "Partner price list 2026."),
  ),
  upload(
    "AUD",
    16,
    {
      name: "mockup-onboarding-step1.png",
      type: "image",
      mime: "image/png",
      sizeBytes: 274_660,
      by: "p-alessia",
      at: at(12, "11:11"),
    },
    ready(
      "Welcome to Audin. Step 1 of 3: connect your phone line.",
      "Mockup of the first onboarding step: connecting the phone line.",
    ),
  ),
];

const TEAM = ["p-laura", "p-matteo", "p-marco", "p-giulia", "p-alessia", "p-stefano", "p-elena"];

export const AUD_OPENS: DriveOpen[] = [
  // Il contratto: 23 aperture negli ultimi 90 giorni, 6 prima.
  ...spread("drv-aud-7", TEAM, 6, 135, 95, "google"),
  ...spread("drv-aud-7", TEAM, 23, 88, 1, "google"),
  ...spread("drv-aud-2", ["p-marco", "p-stefano", "p-alessia", "p-laura"], 3, 128, 100, [
    "preview",
    "download",
  ]),
  ...spread("drv-aud-2", ["p-marco", "p-stefano", "p-alessia", "p-laura"], 17, 85, 2, [
    "preview",
    "download",
  ]),
  ...spread("drv-aud-9", ["p-matteo", "p-laura", "p-elena"], 11, 80, 4, "google"),
  ...spread("drv-aud-10", ["p-matteo", "p-giulia", "p-laura"], 6, 70, 6, "google"),
  ...spread("drv-aud-6", ["p-matteo", "p-laura"], 4, 11, 1, "google"),
  ...spread("drv-aud-5", ["p-giulia", "p-laura", "p-marco"], 3, 30, 3, "google"),
  ...spread("drv-aud-3", ["p-giulia", "p-marco"], 5, 58, 8, "preview"),
  ...spread("drv-aud-4", ["p-marco"], 1, 55, 55, "download"),
  // Il verbale firmato: aperto solo più di 90 giorni fa.
  ...spread("drv-aud-1", ["p-laura", "p-matteo"], 2, 120, 98, "preview"),
];
