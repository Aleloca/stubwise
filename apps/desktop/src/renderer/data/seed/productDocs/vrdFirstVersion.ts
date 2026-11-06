import type { FirstVersionDraftPage, ProductBlock, RichText } from "../../types";
import booking from "../../../assets/productDocs/vrd-booking.png?inline";
import checkIn from "../../../assets/productDocs/vrd-check-in.png?inline";

// La bozza della prima versione di VRD (11b, Task 6, spec «Dati finti»): il
// progetto nuovo senza repository. VRD resta VUOTO nel seme (maintainer, 6
// nov 2026, Q2): questa è la bozza che Claude scrive quando chi prova l'app
// lancia «Write the first version with Claude». Dieci pagine, tre domande
// aperte (ogni dubbio delle fonti), due immagini e il file del Drive del
// progetto (solo se è fra le fonti scelte).
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

const plain = (text: string): RichText => ({ text, marks: [] });

const p = (id: string, text: string): ProductBlock => ({
  id,
  type: "paragraph",
  content: plain(text),
});
const li = (id: string, text: string): ProductBlock => ({
  id,
  type: "bullet",
  indent: 0,
  content: plain(text),
});
const step = (id: string, text: string): ProductBlock => ({
  id,
  type: "numbered",
  indent: 0,
  content: plain(text),
});

const cell = (id: string, text: string) => ({ id, content: plain(text) });

export const VRD_FIRST_VERSION: FirstVersionDraftPage[] = [
  {
    key: "overview",
    parentKey: null,
    title: "Overview",
    blocks: [
      p(
        "ov-1",
        "The app lets the members of Palestra Verde Città book classes, show their membership at the desk and get reminders before a class starts.",
      ),
      p("ov-2", "It replaces the paper sheets at the front desk and the phone bookings."),
      {
        id: "ov-3",
        type: "drive",
        fileId: VRD_IDS.driveFileId,
        code: "VRD-F1",
        onlyWith: `drive:${VRD_IDS.driveFileId}`,
      },
    ],
  },
  {
    key: "features",
    parentKey: null,
    title: "Features",
    blocks: [
      p("ft-1", "What the first release of the app does, one page per feature."),
      li("ft-2", "Class booking"),
      li("ft-3", "Memberships"),
      li("ft-4", "Check-in at the desk"),
      li("ft-5", "Reminders"),
    ],
  },
  {
    key: "booking",
    parentKey: "features",
    title: "Class booking",
    blocks: [
      p("bk-1", "Members book a class from the weekly timetable, up to seven days ahead."),
      p("bk-2", "Members can cancel a booking up to two hours before the class."),
      p("bk-3", "A full class shows how many places are left as zero, and the Book button is off."),
      {
        id: "bk-4",
        type: "image",
        src: booking,
        caption: "The weekly timetable",
        alt: "A week strip with three class cards and a Book button on the first one",
      },
    ],
    questions: [
      {
        anchorKey: "bk-3",
        fact: {
          id: "vrd-fv-waiting-list",
          change: {
            kind: "replace",
            text: plain(
              "A full class offers a waiting list: the first member in line gets the place that frees up.",
            ),
          },
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
      p("ms-1", "Each member has one plan; the plan decides which classes they can book."),
      {
        id: "ms-2",
        type: "table",
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
              cell("ms-2-r3b", "Any ten"),
              cell("ms-2-r3c", "90 euros"),
            ],
          },
        ],
      },
      p("ms-3", "Students get 20% off the monthly plan."),
    ],
    questions: [
      {
        anchorKey: "ms-3",
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
      p(
        "ci-1",
        "At the desk the member shows a code from the app; the staff scan it and the booking is marked as attended.",
      ),
      {
        id: "ci-2",
        type: "image",
        src: checkIn,
        caption: "The check-in code",
        alt: "A square code in the middle of the screen with a caption and a button below",
      },
      p(
        "ci-3",
        "Without a booking, the code still opens the gym for the hours of the member's plan.",
      ),
    ],
  },
  {
    key: "reminders",
    parentKey: "features",
    title: "Reminders",
    blocks: [
      p("rm-1", "The app reminds the member of a booked class two hours before it starts."),
      p("rm-2", "A class cancelled by the gym is notified at once, with the reason."),
    ],
  },
  {
    key: "screens",
    parentKey: null,
    title: "Screens",
    blocks: [
      p(
        "sc-1",
        "The first release has four screens: timetable, class, membership and check-in code.",
      ),
      // Task 7 (P33): qui entra la bozza di schermata di Claude (blocco
      // `wireframe` del timetable), dopo questo paragrafo.
      p("sc-2", "The timetable opens on today; the other days are one swipe away."),
    ],
  },
  {
    key: "decisions",
    parentKey: null,
    title: "Client decisions",
    blocks: [
      p("cd-1", "What the client confirmed in writing."),
      li("cd-2", "Bookings open seven days ahead, at midnight."),
      li("cd-3", "No payments in the app for now: plans are paid at the desk."),
      li("cd-4", "The app is in Italian and English."),
    ],
  },
  {
    key: "phases",
    parentKey: null,
    title: "Phases",
    blocks: [
      step("ph-1", "Timetable and booking, tested by the staff."),
      step("ph-2", "Memberships and check-in, with the desk scanner."),
      step("ph-3", "Reminders and the release to all members in the spring."),
    ],
    questions: [
      {
        anchorKey: "ph-3",
        fact: {
          id: "vrd-fv-launch",
          change: {
            kind: "replace",
            text: plain("Reminders and the release to all members on 1 March."),
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
      li("gl-1", "Plan: what a member pays for, monthly or by number of classes."),
      li("gl-2", "Desk: the front desk of the gym, where the staff scan the check-in code."),
      li("gl-3", "Class: a lesson at a fixed time, with a maximum number of places."),
    ],
  },
];
