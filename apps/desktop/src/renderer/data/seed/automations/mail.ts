// Le email che le esecuzioni del seme dicono di aver mandato (R-J10): ognuna
// è un messaggio inviato nella Posta del proprietario (Matteo), nella sua
// conversazione col cliente, così una risposta simulata del cliente arriva
// lì e sblocca l'attesa. Entrano in `MAIL_MESSAGES` (seed/mail).
import type { MailMessage } from "../../types";
import { at, done, ext, mail, person } from "../mail/helpers";
import { AUDIN_SAMPLE_EVENTS, WEBHOOK_SAMPLE_EVENTS } from "./sources";

export const AUTOMATION_MAIL_IDS = {
  /** AUT-1 #1: il benvenuto a Cantina Bellavista, approvato. */
  welcome: "mm-aut1-1-welcome",
  /** AUD-A1 #1: la richiesta dati a Cantina Bellavista, e la sua risposta. */
  bellavistaAsk: "mm-auda1-1-ask",
  bellavistaReply: "mm-auda1-1-reply",
  /** AUD-A1 #2: la richiesta dati a Mix Cucine, ancora senza risposta. */
  mixAsk: "mm-auda1-2-ask",
} as const;

const OWNER = "p-matteo";
const sent = { state: "sent" as const, sentById: OWNER };

type Client = { cliente: { nome: string; email: string } };
type Request = Client & { richiesta: { funzione: string; dati: string } };

const BELLAVISTA_DEAL = AUDIN_SAMPLE_EVENTS[0] as unknown as Client;
const BELLAVISTA = WEBHOOK_SAMPLE_EVENTS[0] as unknown as Request;
const MIX = WEBHOOK_SAMPLE_EVENTS[1] as unknown as Request;

/** La risposta di Cantina Bellavista, quella che l'esecuzione ha letto. */
export const BELLAVISTA_REPLY =
  "Buongiorno, i numeri da collegare sono 0577 000111 e 0577 000112. Siamo aperti dal lunedì al sabato, dalle 9 alle 18.";

/** La richiesta dati (passo `cd-ask` di AUD-A1), compilata per un cliente. */
const askOf = (r: Request) => ({
  subject: `Ci servono alcuni dati per attivare ${r.richiesta.funzione}`,
  text: `Gentile ${r.cliente.nome},\n\nper attivare ${r.richiesta.funzione} ci servono: ${r.richiesta.dati}\n\nPuò rispondere direttamente a questa email.\n\nGrazie,\nil team Audin`,
});

const client = (c: Client) => ext(c.cliente.nome, c.cliente.email);

export const AUTOMATION_MAIL: MailMessage[] = [
  mail({
    id: AUTOMATION_MAIL_IDS.welcome,
    threadId: "th-aut1-1",
    from: person(OWNER),
    to: [client(BELLAVISTA_DEAL)],
    subject: `Benvenuti in Audin, ${BELLAVISTA_DEAL.cliente.nome}`,
    at: at(11, "09:30"),
    text: `Gentile ${BELLAVISTA_DEAL.cliente.nome},\n\ngrazie per averci scelto. Nei prossimi giorni il nostro team vi contatterà per l'attivazione di CRM.\n\nA presto,\nil team Audin`,
    mailboxPersonIds: [OWNER],
    readByPersonIds: [OWNER],
    classification: { state: "off" },
    delivery: sent,
  }),
  mail({
    id: AUTOMATION_MAIL_IDS.bellavistaAsk,
    threadId: "th-auda1-1",
    from: person(OWNER),
    to: [client(BELLAVISTA)],
    ...askOf(BELLAVISTA),
    at: at(6, "09:40"),
    mailboxPersonIds: [OWNER],
    readByPersonIds: [OWNER],
    classification: { state: "off" },
    delivery: sent,
  }),
  mail({
    id: AUTOMATION_MAIL_IDS.bellavistaReply,
    threadId: "th-auda1-1",
    from: client(BELLAVISTA),
    to: [person(OWNER)],
    subject: `Re: ${askOf(BELLAVISTA).subject}`,
    at: at(4, "15:20"),
    text: BELLAVISTA_REPLY,
    mailboxPersonIds: [OWNER],
    readByPersonIds: [OWNER],
    classification: done(["prj-aud"], "normal"),
  }),
  mail({
    id: AUTOMATION_MAIL_IDS.mixAsk,
    threadId: "th-auda1-2",
    from: person(OWNER),
    to: [client(MIX)],
    ...askOf(MIX),
    at: at(3, "10:15"),
    mailboxPersonIds: [OWNER],
    readByPersonIds: [OWNER],
    classification: { state: "off" },
    delivery: sent,
  }),
];
