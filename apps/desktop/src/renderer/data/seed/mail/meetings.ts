import type { MailMessage, MeetingTranscript } from "../../types";
import { at, done, ext, mail, person } from "./helpers";

// Le riunioni registrate: l'email di Gemini dopo la revisione settimanale di
// AUD di ieri, col Google Doc letto, il riassunto e le quattro task proposte
// (in `proposals.ts`); e una dopo la riunione di MKX con il documento non
// raggiungibile.

/**
 * L'evento della revisione settimanale di AUD di ieri (15:30–16:30, Meet):
 * lo crea il seme del calendario (Task 5) con questo id. Partecipanti:
 * Giulia, Matteo, Laura e Marco.
 */
export const EV_AUD_REVIEW_YESTERDAY = "ev-aud-review-yesterday";

const GEMINI = ext("Gemini", "gemini-notes@google.com");

export const MEETING_MESSAGE_IDS = {
  transcript: "mm-gemini-aud-review",
  transcriptUnreachable: "mm-gemini-mkx-sync",
} as const;

export const MEETING_MESSAGES: MailMessage[] = [
  mail({
    id: MEETING_MESSAGE_IDS.transcript,
    messageId: "<notes-aud-weekly-review.20261022@google.com>",
    threadId: "th-gemini-aud-review",
    from: GEMINI,
    to: [person("p-giulia"), person("p-matteo"), person("p-laura"), person("p-marco")],
    subject: "Notes: “AUD weekly review”",
    at: at(1, "16:40"),
    text: "Meeting notes for “AUD weekly review” are ready. Open the notes in Google Docs to see the summary, the next steps and the transcript.",
    kind: "transcript",
    // Solo le caselle collegate: Laura è scaduta, Marco non ha l'account.
    mailboxPersonIds: ["p-giulia", "p-matteo"],
    readByPersonIds: ["p-matteo"],
    classification: done(["prj-aud"], "normal"),
  }),
  mail({
    id: MEETING_MESSAGE_IDS.transcriptUnreachable,
    messageId: "<notes-mkx-content-sync.20261020@google.com>",
    threadId: "th-gemini-mkx-sync",
    from: GEMINI,
    to: [person("p-giulia"), person("p-chiara")],
    subject: "Notes: “MKX content sync”",
    at: at(3, "17:10"),
    text: "Meeting notes for “MKX content sync” are ready. Open the notes in Google Docs.",
    kind: "transcript",
    mailboxPersonIds: ["p-giulia"],
    classification: done(["prj-mkx"], "low"),
  }),
];

const AUD_REVIEW_TRANSCRIPT = [
  "Matteo Conti: Sofia confirmed the go-live plan is fine, but she wants the revised version in writing by Friday.",
  "Laura Costa: The dialer is feature complete. I'd send the client the acceptance checklist so they can start testing.",
  "Giulia Ferri: Agreed. Who looks at the slow dashboard for the big accounts? Sofia mentioned it again.",
  "Laura Costa: Alessia already knows that code. Let's ask her to measure the three largest accounts first.",
  "Giulia Ferri: For the launch announcement we'll need visuals. Chiara made the ones for the spring campaign, I'd ask her.",
  "Marco Bellini: Fine by me. I'll keep the billing export changes on my side.",
].join("\n");

export const MEETING_TRANSCRIPTS: MeetingTranscript[] = [
  {
    messageId: MEETING_MESSAGE_IDS.transcript,
    eventId: EV_AUD_REVIEW_YESTERDAY,
    docTitle: "AUD weekly review – Notes by Gemini",
    doc: "ready",
    transcript: AUD_REVIEW_TRANSCRIPT,
    summary:
      "The client accepts the go-live plan but wants it in writing by Friday. The dialer is ready for acceptance testing; the slow dashboard of large accounts needs measuring; the launch announcement needs visuals.",
  },
  {
    messageId: MEETING_MESSAGE_IDS.transcriptUnreachable,
    // La riunione l'ha organizzata Chiara, senza account collegato: nessun
    // evento in calendario da collegare, e senza documento nessun riassunto.
    eventId: null,
    docTitle: "MKX content sync – Notes by Gemini",
    doc: "unreachable",
    transcript: "",
    summary: null,
  },
];
