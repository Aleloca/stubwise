import nodemailer from "nodemailer";

/**
 * Area 9, F1 (E-1 = a; docs/invariants/identity.md, second-factor.md): il
 * trasporto email d'istanza, FACOLTATIVO. Serve SOLO il link del cambio
 * dell'email di login (alla nuova) e l'avviso alla vecchia: nient'altro passa
 * di qui. Senza `SMTP_URL`, `isConfigured()` è falso e chi lo usa lo dice.
 *
 * `nodemailer` è CommonJS: si importa dal default (la guardia
 * `scripts/check-esm-named-imports.mjs`).
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailTransport {
  isConfigured(): boolean;
  send(message: MailMessage): Promise<void>;
}

export const NO_MAIL_TRANSPORT: MailTransport = {
  isConfigured: () => false,
  async send() {
    throw new Error("nessun trasporto email configurato");
  },
};

export function smtpTransport(url: string | undefined, from: string | undefined): MailTransport {
  if (!url || !from) return NO_MAIL_TRANSPORT;
  const transporter = nodemailer.createTransport(url);
  return {
    isConfigured: () => true,
    async send(message) {
      // Testo semplice, mai HTML: l'indirizzo e il link sono gli unici dati.
      await transporter.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
    },
  };
}
