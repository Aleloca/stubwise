import type { MailProposal } from "../../types";
import { daysFromToday } from "../dates";
import { at } from "./helpers";
import { MEETING_MESSAGES, MEETING_MESSAGE_IDS } from "./meetings";
import { MESSAGE_IDS, PROJECT_MESSAGES } from "./messages";

// Le proposte della posta, una per email (Message-ID) e progetto: task,
// richieste, aggiornamenti e commenti; per l'email incerta fra AUD e MKX una
// «scegli il progetto» (`chooseProject`), con le azioni già pronte per
// ciascun candidato. Il suo `projectId` è il primo candidato: la proposta
// non è ancora di nessun progetto, e la vede chi è membro di uno dei due.

const sourceOf = (id: string): string => {
  const m = [...PROJECT_MESSAGES, ...MEETING_MESSAGES].find((x) => x.id === id);
  if (!m) throw new Error(`Unknown mail message: ${id}`);
  return m.messageId;
};

/** Ancora aperta: nessuno ha deciso. */
const undecided = (): Pick<
  MailProposal,
  "status" | "decidedById" | "decidedAt" | "resultCodes" | "error" | "handedAt" | "handedById"
> => ({
  status: "open",
  decidedById: null,
  decidedAt: null,
  resultCodes: [],
  error: null,
  handedAt: null,
  handedById: null,
});

export const MAIL_PROPOSALS: MailProposal[] = [
  // Condivisa fra Giulia, Matteo e Laura (tutti e tre in AUD), ancora aperta.
  {
    id: "mp-aud-billing-vat",
    source: "email",
    sourceId: sourceOf(MESSAGE_IDS.shared),
    projectId: "prj-aud",
    actions: [
      {
        fn: "createTask",
        args: {
          projectId: "prj-aud",
          title: "Add the VAT number column to the billing export",
          description:
            "Our accountant can't reconcile the monthly billing export without the customer's VAT number. We need it for the close on Monday 26 October.",
          assigneeId: "p-marco",
          dueDate: daysFromToday(3),
        },
        summary: "Create in AUD: “Add the VAT number column to the billing export” · Marco Bellini",
      },
    ],
    excerpt:
      "Could you add a VAT number column to the CSV export? We need it for the close on Monday 26 October.",
    createdAt: at(6, "09:22"),
    ...undecided(),
  },
  // Già confermata da Matteo: il commento è sulla task dei callback.
  {
    id: "mp-aud-callbacks-monday",
    source: "email",
    sourceId: sourceOf(MESSAGE_IDS.confirmed),
    projectId: "prj-aud",
    actions: [
      {
        fn: "addComment",
        args: {
          taskId: "t-aud-9",
          body: "The client reports that callbacks scheduled for Monday morning still fire one hour late for the Rome office; the other days are right.",
        },
        summary: "Comment on AUD-9 · Monday callbacks still an hour late",
      },
    ],
    excerpt:
      "The callbacks scheduled for Monday morning still fire one hour late for the Rome office. The other days look right.",
    createdAt: at(2, "08:07"),
    status: "confirmed",
    decidedById: "p-matteo",
    decidedAt: at(2, "09:15"),
    resultCodes: ["AUD-9"],
    error: null,
    handedAt: null,
    handedById: null,
  },
  // STW, aperta: Giulia (Contributor) può crearla.
  {
    id: "mp-stw-copy-freeze",
    source: "email",
    sourceId: sourceOf(MESSAGE_IDS.stwHigh),
    projectId: "prj-stw",
    actions: [
      {
        fn: "createTask",
        args: {
          projectId: "prj-stw",
          title: "Finish the onboarding copy before the preview freeze",
          assigneeId: "p-giulia",
          dueDate: daysFromToday(1),
        },
        summary:
          "Create in STW: “Finish the onboarding copy before the preview freeze” · Giulia Ferri",
      },
    ],
    excerpt:
      "We freeze the copy of the desktop preview tomorrow at 17:00. Anything still open in the onboarding screens needs to land before then.",
    createdAt: at(0, "10:17"),
    ...undecided(),
  },
  // Passata al progetto da Giulia: in STW è Contributor, senza `tickets.edit`.
  {
    id: "mp-stw-release-notes-date",
    source: "email",
    sourceId: sourceOf(MESSAGE_IDS.handed),
    projectId: "prj-stw",
    actions: [
      {
        fn: "updateTask",
        args: { id: "t-stw-11", patch: { dueDate: daysFromToday(7) } },
        summary: "Update STW-11 · due 30 Oct",
      },
    ],
    excerpt:
      "The wording of the release notes is approved on our side. We'd publish them together with the preview on 30 October rather than this week.",
    createdAt: at(3, "14:52"),
    status: "handed",
    decidedById: "p-giulia",
    decidedAt: at(3, "15:30"),
    resultCodes: [],
    error: null,
    handedAt: at(3, "15:30"),
    handedById: "p-giulia",
  },
  // Incerta fra AUD e MKX (Giulia e Matteo sono in entrambi): si sceglie il
  // progetto, poi si conferma la task di quel progetto.
  {
    id: "mp-video-testimonials",
    source: "email",
    sourceId: sourceOf(MESSAGE_IDS.uncertain),
    projectId: "prj-aud",
    actions: [
      {
        fn: "chooseProject",
        args: {
          projectIds: ["prj-aud", "prj-mkx"],
          actionsByProject: {
            "prj-aud": [
              {
                fn: "createTask",
                args: {
                  projectId: "prj-aud",
                  title: "Book the customer testimonial shooting (4 or 5 November)",
                  description:
                    "Cristina Valli can shoot the customer testimonials on 4 or 5 November and is waiting for the campaign before sending the quote.",
                },
                summary:
                  "Create in AUD: “Book the customer testimonial shooting (4 or 5 November)”",
              },
            ],
            "prj-mkx": [
              {
                fn: "createTask",
                args: {
                  projectId: "prj-mkx",
                  title: "Book the testimonial video shooting for the product launch",
                  description:
                    "Cristina Valli can shoot the customer testimonials on 4 or 5 November and is waiting for the campaign before sending the quote.",
                },
                summary:
                  "Create in MKX: “Book the testimonial video shooting for the product launch”",
              },
            ],
          },
        },
        summary: "Choose the project: AUD or MKX",
      },
    ],
    excerpt:
      "We can shoot the customer testimonials on 4 or 5 November. Which campaign are they for, the product launch or the spring one?",
    createdAt: at(1, "15:24"),
    ...undecided(),
  },
  // Dalla revisione settimanale di AUD: quattro task, una per Chiara
  // (marketing), che non è nel progetto né era alla riunione.
  {
    id: "mp-aud-weekly-review",
    source: "transcript",
    sourceId: sourceOf(MEETING_MESSAGE_IDS.transcript),
    projectId: "prj-aud",
    actions: [
      {
        fn: "createTask",
        args: {
          projectId: "prj-aud",
          title: "Send Sofia the revised go-live plan in writing",
          assigneeId: "p-matteo",
          dueDate: daysFromToday(1),
        },
        summary: "Create in AUD: “Send Sofia the revised go-live plan in writing” · Matteo Conti",
      },
      {
        fn: "createTask",
        args: {
          projectId: "prj-aud",
          title: "Share the dialer acceptance checklist with the client",
          assigneeId: "p-laura",
        },
        summary:
          "Create in AUD: “Share the dialer acceptance checklist with the client” · Laura Costa",
      },
      {
        fn: "createTask",
        args: {
          projectId: "prj-aud",
          title: "Measure the dashboard load time of the three largest accounts",
          assigneeId: "p-alessia",
        },
        summary:
          "Create in AUD: “Measure the dashboard load time of the three largest accounts” · Alessia Neri",
      },
      {
        fn: "createTask",
        args: {
          projectId: "prj-aud",
          title: "Visuals for the launch announcement",
          assigneeId: "p-chiara",
        },
        summary: "Create in AUD: “Visuals for the launch announcement” · Chiara Lombardi",
      },
    ],
    excerpt:
      "The client accepts the go-live plan but wants it in writing by Friday. The dialer is ready for acceptance testing; the slow dashboard of large accounts needs measuring; the launch announcement needs visuals.",
    createdAt: at(1, "16:45"),
    ...undecided(),
  },
];
