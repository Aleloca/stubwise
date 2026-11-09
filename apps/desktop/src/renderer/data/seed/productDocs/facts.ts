import type { ProductBlock, ProductFact, RichText } from "../../types";

// I fatti delle fonti del seme sulla doc di prodotto di ACQ (11b). Il
// prototipo non legge le fonti: per ogni fonte qui c'è cosa dice alla doc,
// e cosa farne lo decide la regola (`decideFact`). La chiave è
// `<kind>:<id>` della fonte (`ProductSourceRef`), come la usa
// `noteProductSource`. Due fonti nascono solo al loro arrivo, quindi il loro
// id non c'è prima: la decisione da registrare si chiave col suo titolo
// (`decision:<titolo>`), il rilascio con la PR da cui nasce
// (`release:<repo>#<numero>`).
//
// Due gruppi:
// - le fonti GIÀ ARRIVATE nel seme (`acq11b.ts` scrive revisioni, segni,
//   commenti e card come cose accadute, e le segna viste): un secondo arrivo
//   non riscrive niente;
// - i COPIONI, che arrivano mentre si prova l'app: l'email e la riunione in
//   arrivo nella casella di Matteo («Aggiorna ora»), la decisione preparata,
//   la task preparata (chiusa: costruita diversa) e il merge della PR #77.
//   Coprono le tre uscite della regola: modifica, domanda, niente.

/** Gli id del seme del 11b, per i test e le aree che vengono dopo. */
export const ACQ_11B = {
  // Fonti già arrivate.
  /** L'email di Laura «solo Google» (Sign-in). */
  signInEmailId: "mm-acq-signin-google",
  /** L'email delle tre foto (Fault reports): NON è nello stato, la fonte non c'è più. */
  goneEmailId: "mm-acq-fault-photos-old",
  /** L'email di Gemini dopo la revisione del portale di martedì (Bills). */
  meetingId: "mm-gemini-acq-review",
  meetingEventId: "ev-acq-portal-review",
  /** La task chiusa costruita diversa (Meter reading). */
  closedTaskId: "t-acq-8",
  /** La decisione del registro che Claude ha portato in Client decisions. */
  decisionId: "dl-acq-3",
  // Copioni.
  /** L'email in arrivo nella casella di Matteo (Features). */
  incomingEmailId: "mm-acq-fault-photo-limit",
  /** L'email di Gemini in arrivo nella casella di Matteo (Phases). */
  incomingMeetingId: "mm-gemini-acq-weekly",
  incomingMeetingEventId: "ev-acq-weekly-check",
  /** La task aperta che, chiusa, diverge dalla doc (Meter reading). */
  openTaskId: "t-acq-9",
  /** La PR il cui merge è un rilascio di ACQ (Features). */
  releasePrId: "opr-acq-77",
  // Il resto del seme.
  /** La task nata dalla richiesta che viene da Phases. */
  requestTaskId: "t-acq-10",
  requestIds: ["req-acq-6", "req-acq-7"],
} as const;

/** La decisione che il seme prepara: chi la registra (Laura) fa aggiornare Bills. */
export const PREPARED_DECISION = {
  title: "Instalments for bills over 200 euros",
  decision: "Bills over 200 euros can be paid in three monthly instalments.",
  context: "The utility wants to help the households with the larger winter bills.",
} as const;

/** La PR il cui merge fa nascere il rilascio dei copioni. */
const RELEASE_KEY = "release:audin/portale-utenti#77";

const plain = (text: string): RichText => ({ text, marks: [] });

const para = (id: string, text: string): ProductBlock => ({
  id,
  type: "paragraph",
  content: plain(text),
});

const PAGE = {
  features: "pp-acq-features",
  signIn: "pp-acq-sign-in",
  bills: "pp-acq-bills",
  meter: "pp-acq-meter-reading",
  faults: "pp-acq-fault-reports",
  decisions: "pp-acq-client-decisions",
  phases: "pp-acq-phases",
} as const;

// --- le fonti già arrivate -----------------------------------------------------

/** Sign-in: l'email di Laura dice chiaro «solo Google». */
export const SIGN_IN_FACT: ProductFact = {
  id: "fact-acq-signin-google-only",
  pageId: PAGE.signIn,
  anchorId: "blk-acq-signin-2",
  change: {
    kind: "insert_after",
    block: para(
      "blk-fact-acq-signin",
      "Google is the only way in: there is no password of our own and no other kind of account.",
    ),
  },
  clarity: "clear",
};

/** Fault reports: un'email (oggi sparita) diceva chiaro «fino a tre foto». */
export const FAULTS_FACT: ProductFact = {
  id: "fact-acq-faults-three-photos",
  pageId: PAGE.faults,
  anchorId: "blk-acq-faults-2",
  change: {
    kind: "replace",
    text: plain(
      "A customer describes the fault, picks the address on the map and can attach up to three photos.",
    ),
  },
  clarity: "clear",
};

/** Bills: alla riunione si è detto «forse» un promemoria anche per email. */
export const BILLS_MEETING_FACT: ProductFact = {
  id: "fact-acq-bills-reminder-email",
  pageId: PAGE.bills,
  anchorId: "blk-acq-bills-3",
  change: {
    kind: "insert_after",
    block: para(
      "blk-fact-acq-bills-email",
      "The reminder also goes out by email, a week before the due date.",
    ),
  },
  clarity: "vague",
  options: {
    request: {
      title: "Bill reminder by email",
      description:
        "At the portal review the utility asked whether the bill reminder could also go out by email, a week before the due date. Nobody decided it yet.",
    },
  },
};

/** Meter reading: la task chiusa accetta una lettura più bassa dopo un cambio di contatore. */
export const METER_CLOSED_TASK_FACT: ProductFact = {
  id: "fact-acq-meter-lower-reading",
  pageId: PAGE.meter,
  anchorId: "blk-acq-meter-4",
  change: {
    kind: "diverges",
    built:
      "A reading lower than the previous one is accepted when the meter was replaced in the same month.",
  },
  clarity: "clear",
  options: {
    apply: plain(
      "A reading lower than the previous one is refused, with a message that says why, unless the meter was replaced in the same month.",
    ),
  },
  recommended: "apply",
};

/** Client decisions: la decisione del registro sulle foto entra come blocco. */
export const DECISIONS_FACT: ProductFact = {
  id: "fact-acq-decisions-photos",
  pageId: PAGE.decisions,
  anchorId: "blk-acq-decisions-3",
  change: {
    kind: "insert_after",
    block: { id: "blk-fact-acq-decisions", type: "decision", decisionId: ACQ_11B.decisionId },
  },
  clarity: "clear",
};

// --- i copioni -----------------------------------------------------------------

/** L'email in arrivo: «fino a tre foto», chiaro, sull'elenco delle funzioni. */
export const INCOMING_EMAIL_FACT: ProductFact = {
  id: "fact-acq-features-photos",
  pageId: PAGE.features,
  anchorId: "blk-acq-features-5",
  change: { kind: "replace", text: plain("Fault reports, with up to three photos") },
  clarity: "clear",
};

/** La riunione in arrivo: un «forse» sull'aspetto scuro (domanda)… */
export const INCOMING_MEETING_VAGUE_FACT: ProductFact = {
  id: "fact-acq-phases-dark-earlier",
  pageId: PAGE.phases,
  anchorId: "blk-acq-phases-5",
  change: { kind: "replace", text: plain("Phase 2: a dark appearance") },
  clarity: "vague",
};

/** …e un fatto sul passo che Matteo ha tolto: l'ancora non c'è più (niente). */
export const INCOMING_MEETING_GONE_FACT: ProductFact = {
  id: "fact-acq-phases-paper-bills",
  pageId: PAGE.phases,
  anchorId: "blk-acq-phases-paper",
  change: { kind: "replace", text: plain("Phase 3: paper bills by post, only on request") },
  clarity: "clear",
};

/** La decisione preparata: le rate entrano in Bills, dopo il pagamento. */
export const PREPARED_DECISION_FACT: ProductFact = {
  id: "fact-acq-bills-instalments",
  pageId: PAGE.bills,
  anchorId: "blk-acq-bills-3",
  change: {
    kind: "insert_after",
    block: para("blk-fact-acq-bills-instalments", PREPARED_DECISION.decision),
  },
  clarity: "clear",
};

/** La task preparata: costruita con la foto del contatore, che la doc non dice. */
export const OPEN_TASK_FACT: ProductFact = {
  id: "fact-acq-meter-photo",
  pageId: PAGE.meter,
  anchorId: "blk-acq-meter-1",
  change: {
    kind: "diverges",
    built: "Customers can also send a photo of the meter; the support team types the reading.",
  },
  clarity: "clear",
  options: {
    apply: plain(
      "Customers send the reading of their meter once a month, from the portal, by text message or with a photo of the meter.",
    ),
  },
  recommended: "apply",
};

/** Il rilascio della PR #77 (ACQ-7): la doc cita la task dove ne parla. */
export const RELEASE_FACT: ProductFact = {
  id: "fact-acq-features-bill-reminder",
  pageId: PAGE.features,
  anchorId: "blk-acq-features-3",
  change: { kind: "link_task", taskCode: "ACQ-7" },
  clarity: "clear",
};

/** I fatti di ogni fonte del seme, per chiave `<kind>:<id>` (vedi in cima). */
export const PRODUCT_SOURCE_FACTS: Record<string, readonly ProductFact[]> = {
  [`email:${ACQ_11B.signInEmailId}`]: [SIGN_IN_FACT],
  [`email:${ACQ_11B.goneEmailId}`]: [FAULTS_FACT],
  [`meeting:${ACQ_11B.meetingId}`]: [BILLS_MEETING_FACT],
  [`task:${ACQ_11B.closedTaskId}`]: [METER_CLOSED_TASK_FACT],
  [`decision:${ACQ_11B.decisionId}`]: [DECISIONS_FACT],
  [`email:${ACQ_11B.incomingEmailId}`]: [INCOMING_EMAIL_FACT],
  [`meeting:${ACQ_11B.incomingMeetingId}`]: [
    INCOMING_MEETING_VAGUE_FACT,
    INCOMING_MEETING_GONE_FACT,
  ],
  [`decision:${PREPARED_DECISION.title}`]: [PREPARED_DECISION_FACT],
  [`task:${ACQ_11B.openTaskId}`]: [OPEN_TASK_FACT],
  [RELEASE_KEY]: [RELEASE_FACT],
};

/** Le chiavi dei copioni (le fonti che arrivano mentre si prova l'app). */
export const PRODUCT_SCRIPTED_SOURCE_KEYS: readonly string[] = [
  `email:${ACQ_11B.incomingEmailId}`,
  `meeting:${ACQ_11B.incomingMeetingId}`,
  `decision:${PREPARED_DECISION.title}`,
  `task:${ACQ_11B.openTaskId}`,
  RELEASE_KEY,
];
