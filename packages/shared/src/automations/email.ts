import { AUTOMATION_LIMITS } from "./fields.js";
import {
  failed,
  personName,
  refuse,
  type ActionEffect,
  type Planned,
  type PlanWorld,
} from "./plans.js";

// Il piano di «Manda email» (area 7, F2, R2): i controlli dell'esecuzione
// vera senza mandare niente. La casella del proprietario la dice il mondo
// (nel prototipo lo store, nella prova il contesto del server, nel worker il
// DB); il resto è puro, così prova, prototipo e worker falliscono allo
// stesso passo, con lo stesso codice e la stessa motivazione.

/** La casella da cui partirebbe un'email del proprietario, o perché non c'è. */
export type OwnerMailbox =
  | { ok: true; address: string }
  | {
      ok: false;
      /** La scelta all'accensione non è più sua; nessuna; scaduta; senza il permesso d'invio. */
      reason: "chosen_gone" | "none" | "expired" | "no_scope";
    };

export interface EmailWorld extends PlanWorld {
  /** `chosen`: la casella scelta accendendo o pubblicando; `null` = la sua. */
  ownerMailbox(owner: string, chosen: string | null): OwnerMailbox;
}

export interface EmailPlan {
  /** L'indirizzo della casella del proprietario da cui partirebbe. */
  from: string;
  to: string;
  subject: string;
  body: string;
  attachments: unknown[];
}

/**
 * UN indirizzo email (review F2, M4): niente spazi, virgole, punti e virgola,
 * parentesi angolari, virgolette o parentesi — un «To» preso dal testo di
 * un'email (`a,evil@x.y`) non deve diventare due destinatari né
 * un'intestazione. Più stretta della Posta, dove l'indirizzo lo scrive una
 * persona: qui può venire da un dato non fidato.
 */
export const EMAIL_ADDRESS = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * La conversazione di un'email: quella aperta dalla prima email allo stesso
 * indirizzo, se c'è (le email allo stesso indirizzo stanno in UNA conversazione).
 */
export function sameConversation<T extends { to: string }>(
  sent: readonly T[],
  to: string,
): T | undefined {
  return sent.find((e) => same(e.to, to));
}

/**
 * `sentSoFar`: le email già partite dalla catena (il tetto le conta tutte);
 * `mailbox`: la casella scelta (`Automation.mailbox`), `null` = la sua.
 */
export function planEmail(
  w: EmailWorld,
  eff: ActionEffect,
  owner: string,
  sentSoFar: number,
  mailbox: string | null,
): Planned<EmailPlan> {
  const args = eff.args as { to: string; subject: string; body: string; attachments: unknown[] };
  const max = AUTOMATION_LIMITS.emailsPerRun;
  if (sentSoFar >= max) {
    return refuse(
      failed(
        "email_limit",
        { code: "emailLimitChain", params: { max } },
        `Limite raggiunto: al massimo ${max} email per esecuzione, contando le automazioni avviate da questa.`,
      ),
    );
  }
  const name = personName(w, owner);
  const box = w.ownerMailbox(owner, mailbox);
  if (!box.ok) {
    switch (box.reason) {
      case "chosen_gone":
        return refuse(
          failed(
            "mailbox_missing",
            { code: "mailboxGone", params: { mailbox: mailbox ?? "", owner: name } },
            `La casella scelta per l'automazione (${mailbox ?? ""}) non è più collegata a ${name}: l'email non è partita.`,
          ),
        );
      case "none":
        return refuse(
          failed(
            "mailbox_missing",
            { code: "noMailbox", params: { owner: name } },
            `Il proprietario (${name}) non ha una casella collegata: l'email non è partita.`,
          ),
        );
      case "expired":
        return refuse(
          failed(
            "mailbox_expired",
            { code: "mailboxExpired", params: { owner: name } },
            `La casella del proprietario (${name}) è scaduta: va ricollegata prima di riprovare.`,
          ),
        );
      case "no_scope":
        return refuse(
          failed(
            "mailbox_scope",
            { code: "mailboxScope", params: { owner: name } },
            `La casella del proprietario (${name}) non ha il permesso d'invio: va ricollegata prima di riprovare.`,
          ),
        );
    }
  }
  const to = args.to.trim();
  if (!EMAIL_ADDRESS.test(to))
    return refuse(
      failed(
        "invalid_address",
        { code: "invalidAddress", params: { to } },
        `«${to}» non è un indirizzo email.`,
      ),
    );
  return {
    ok: true,
    plan: {
      from: box.address,
      to,
      subject: args.subject,
      body: args.body,
      attachments: args.attachments,
    },
  };
}
