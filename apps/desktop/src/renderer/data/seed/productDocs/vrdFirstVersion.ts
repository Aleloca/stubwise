import type { FirstVersionDraftPage, ProductBlock, RichText } from "../../types";
import booking from "../../../assets/productDocs/vrd-booking.png?inline";
import checkIn from "../../../assets/productDocs/vrd-check-in.png?inline";

// La bozza della prima versione di VRD (11b, Task 6, spec «Dati finti»): il
// progetto nuovo senza repository. VRD resta VUOTO nel seme (maintainer, 6
// nov 2026, Q2): questa è la bozza che Claude scrive quando chi prova l'app
// lancia «Write the first version with Claude». Dieci pagine, tre domande
// aperte, due immagini e il file del Drive del progetto.
//
// Anti-obiettivo «decisioni inventate»: OGNI blocco dice la fonte del seme
// che lo dice (`onlyWith`) ed entra solo se quella fonte è fra le scelte.
// Le fonti sono tre: l'email delle prenotazioni (`BOOKING`), quella degli
// abbonamenti (`PLANS`), entrambe in `seed/mail/messages.ts`, e il brief del
// Drive (`BRIEF`, `seed/drive/vrd.ts`). Una frase che nessuna delle tre dice
// non c'è; un «forse» delle fonti è una domanda, con la frase della fonte
// come proposta. Il testo incollato non ha un contenuto noto: la bozza lo
// cita (la riga delle fonti in Overview) e non gli attribuisce niente. Una
// pagina senza blocchi delle fonti scelte dice che le fonti non ne parlano
// (`firstVersion.ts`).
//
// Gli id dei blocchi valgono solo qui: alla scrittura prendono id nuovi
// (`newId`), così una seconda prima versione dopo «Annulla» non riusa id
// già dati. Le domande nominano il blocco con il suo id di qui.
//
// La bozza di schermata (blocco `wireframe`) NON è qui: il tipo nasce nel
// Task 7 (ruling del controller P33), che la aggiunge alla pagina «Screens»
// nel punto segnato più sotto.

/** Gli id del seme che la prima versione di VRD usa (fonti, file, progetto). */
export const VRD_IDS = {
  projectId: "prj-vrd",
  /** L'email del cliente a Laura (Matteo in copia): le regole delle prenotazioni. */
  lauraEmailId: "mm-vrd-booking-rules",
  /** La seconda email del cliente a Laura: abbonamenti e prezzi. */
  plansEmailId: "mm-vrd-membership-plans",
  /** Il brief del cliente nel Drive di VRD (`VRD-F1`). */
  driveFileId: "drv-vrd-1",
} as const;

const BOOKING = `email:${VRD_IDS.lauraEmailId}`;
const PLANS = `email:${VRD_IDS.plansEmailId}`;
const BRIEF = `drive:${VRD_IDS.driveFileId}`;

type DraftBlock = FirstVersionDraftPage["blocks"][number];

const plain = (text: string): RichText => ({ text, marks: [] });

const p = (from: string, id: string, text: string): DraftBlock => ({
  id,
  type: "paragraph",
  content: plain(text),
  onlyWith: from,
});
const li = (from: string, id: string, text: string): DraftBlock => ({
  id,
  type: "bullet",
  indent: 0,
  content: plain(text),
  onlyWith: from,
});

const cell = (id: string, text: string) => ({ id, content: plain(text) });

const WAITING_LIST: ProductBlock = {
  id: "bk-q",
  type: "paragraph",
  content: plain("When a class is full, members can join a waiting list."),
};

export const VRD_FIRST_VERSION: FirstVersionDraftPage[] = [
  {
    key: "overview",
    parentKey: null,
    title: "Overview",
    blocks: [
      p(
        BRIEF,
        "ov-1",
        "The app lets the members of Palestra Verde Città book classes, show their membership at the desk and get reminders.",
      ),
      { id: "ov-2", type: "drive", fileId: VRD_IDS.driveFileId, code: "VRD-F1", onlyWith: BRIEF },
    ],
  },
  {
    key: "features",
    parentKey: null,
    title: "Features",
    blocks: [
      p(BRIEF, "ft-1", "The brief names three features:"),
      li(BRIEF, "ft-2", "Class booking"),
      li(BRIEF, "ft-3", "Showing the membership at the desk"),
      li(BRIEF, "ft-4", "Reminders"),
    ],
  },
  {
    key: "booking",
    parentKey: "features",
    title: "Class booking",
    blocks: [
      p(BOOKING, "bk-1", "Members book a class up to seven days ahead: bookings open at midnight."),
      p(BOOKING, "bk-2", "Members can cancel a booking up to two hours before the class."),
      {
        id: "bk-3",
        type: "image",
        src: booking,
        caption: "A sketch of the weekly timetable",
        alt: "A week strip with three class cards and a Book button on the first one",
        onlyWith: BOOKING,
      },
    ],
    questions: [
      {
        // «When a class is full, maybe a waiting list, but we are not sure yet.»
        anchorKey: "bk-2",
        onlyWith: BOOKING,
        fact: {
          id: "vrd-fv-waiting-list",
          change: { kind: "insert_after", block: WAITING_LIST },
          options: {
            request: {
              title: "Waiting list for full classes",
              description:
                "The client mentioned a waiting list for full classes as a maybe. Decide whether the first release has it.",
            },
          },
        },
      },
    ],
  },
  {
    key: "memberships",
    parentKey: "features",
    title: "Memberships",
    blocks: [
      p(PLANS, "ms-1", "There are two plans:"),
      {
        id: "ms-2",
        type: "table",
        onlyWith: PLANS,
        rows: [
          {
            id: "ms-2-r1",
            cells: [
              cell("ms-2-r1a", "Plan"),
              cell("ms-2-r1b", "Classes"),
              cell("ms-2-r1c", "Price"),
            ],
          },
          {
            id: "ms-2-r2",
            cells: [
              cell("ms-2-r2a", "Monthly"),
              cell("ms-2-r2b", "All"),
              cell("ms-2-r2c", "49 euros"),
            ],
          },
          {
            id: "ms-2-r3",
            cells: [
              cell("ms-2-r3a", "Ten classes"),
              cell("ms-2-r3b", "10"),
              cell("ms-2-r3c", "90 euros"),
            ],
          },
        ],
      },
      p(PLANS, "ms-3", "Students get 20% off the monthly plan."),
      p(BOOKING, "ms-4", "Plans are paid at the desk: there are no payments in the app for now."),
    ],
    questions: [
      {
        // «we might do the same for members over 65.»
        anchorKey: "ms-3",
        onlyWith: PLANS,
        fact: {
          id: "vrd-fv-seniors",
          change: {
            kind: "replace",
            text: plain("Students and members over 65 get 20% off the monthly plan."),
          },
        },
      },
    ],
  },
  {
    key: "check-in",
    parentKey: "features",
    title: "Check-in at the desk",
    blocks: [
      p(BRIEF, "ci-1", "Members show their membership at the desk from the app."),
      {
        id: "ci-2",
        type: "image",
        src: checkIn,
        caption: "A sketch of the membership shown at the desk",
        alt: "A square code in the middle of the screen with a caption and a button below",
        onlyWith: BRIEF,
      },
    ],
  },
  {
    key: "reminders",
    parentKey: "features",
    title: "Reminders",
    blocks: [p(BRIEF, "rm-1", "Members get reminders from the app.")],
  },
  {
    key: "screens",
    parentKey: null,
    title: "Screens",
    // Nessuna fonte descrive le schermate: la pagina dice che le fonti non ne
    // parlano. Task 7 (P33): qui entra la bozza di schermata di Claude
    // (blocco `wireframe` del timetable), come primo blocco della pagina.
    blocks: [],
  },
  {
    key: "decisions",
    parentKey: null,
    title: "Client decisions",
    blocks: [
      p(BOOKING, "cd-1", "What the client confirmed in the email about bookings:"),
      li(BOOKING, "cd-2", "Bookings open seven days ahead, at midnight."),
      li(BOOKING, "cd-3", "No payments in the app for now: plans are paid at the desk."),
      li(BOOKING, "cd-4", "The app is in Italian and English."),
    ],
  },
  {
    key: "phases",
    parentKey: null,
    title: "Phases",
    blocks: [p(BRIEF, "ph-1", "The app is released in phases, with the launch in the spring.")],
    questions: [
      {
        // «the launch is planned for the spring, maybe in March.»
        anchorKey: "ph-1",
        onlyWith: BRIEF,
        fact: {
          id: "vrd-fv-launch",
          change: {
            kind: "replace",
            text: plain("The app is released in phases, with the launch in March."),
          },
        },
      },
    ],
  },
  {
    key: "glossary",
    parentKey: null,
    title: "Glossary",
    blocks: [
      li(BOOKING, "gl-1", "Class: a lesson that members book, up to seven days ahead."),
      li(PLANS, "gl-2", "Plan: what a member pays for, monthly or ten classes."),
      li(BOOKING, "gl-3", "Desk: where plans are paid."),
    ],
  },
];
