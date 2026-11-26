import { describe, expect, it } from "vitest";

import type { EffectRequest } from "./engine.js";
import { EMAIL_ADDRESS, planEmail, sameConversation, type EmailWorld, type OwnerMailbox } from "./email.js";
import { AUTOMATION_LIMITS } from "./fields.js";

// Area 7, F2 (R2): il piano di «Manda email» nel motore condiviso, perché
// prova (client), prototipo e worker falliscano allo stesso passo con lo
// stesso codice. La casella del proprietario arriva dal mondo
// (`ownerMailbox`), la regola della conversazione è pura (`sameConversation`).

const eff = (
  args: Partial<{ to: string; subject: string; body: string; attachments: unknown[] }> = {},
) =>
  ({
    kind: "sendEmail",
    stepId: "e1",
    args: { to: "cliente@example.com", subject: "Ciao", body: "Testo", attachments: [], ...args },
  }) as unknown as Extract<EffectRequest, { args: unknown }>;

function world(mailbox: OwnerMailbox): EmailWorld {
  return {
    person: (id) => ({ id, name: id === "ada" ? "Ada" : id, departmentIds: [] }),
    isDeactivated: () => false,
    holdersOfRole: () => [],
    departmentRecipients: () => [],
    canSeeProject: () => true,
    projectGone: () => false,
    checkNewTask: () => {},
    checkNewMilestone: () => {},
    checkNewRequest: () => {},
    defaultDepartmentOf: () => null,
    ownerMailbox: () => mailbox,
  };
}
const ok: OwnerMailbox = { ok: true, address: "ada@audin.test" };
const failure = (p: ReturnType<typeof planEmail>) =>
  p.ok ? null : (p.outcome.input as { error?: string; why?: unknown });

describe("il piano di «Manda email»", () => {
  it("dalla casella del proprietario, con destinatario, oggetto, corpo e allegati", () => {
    const p = planEmail(world(ok), eff({ to: "  cliente@example.com " }), "ada", 0, null);
    expect(p).toEqual({
      ok: true,
      plan: {
        from: "ada@audin.test",
        to: "cliente@example.com",
        subject: "Ciao",
        body: "Testo",
        attachments: [],
      },
    });
  });

  it("oltre il tetto di email per esecuzione (la catena intera): `email_limit`", () => {
    const p = planEmail(world(ok), eff(), "ada", AUTOMATION_LIMITS.emailsPerRun, null);
    expect(failure(p)).toMatchObject({ error: "email_limit", why: { code: "emailLimitChain" } });
  });

  it("la casella scelta non è più del proprietario: `mailbox_missing` con l'indirizzo", () => {
    const p = planEmail(
      world({ ok: false, reason: "chosen_gone" }),
      eff(),
      "ada",
      0,
      "vecchia@audin.test",
    );
    expect(failure(p)).toMatchObject({
      error: "mailbox_missing",
      why: { code: "mailboxGone", params: { mailbox: "vecchia@audin.test", owner: "Ada" } },
    });
  });

  it("nessuna casella, una scaduta, una senza il permesso d'invio", () => {
    expect(
      failure(planEmail(world({ ok: false, reason: "none" }), eff(), "ada", 0, null)),
    ).toMatchObject({
      error: "mailbox_missing",
      why: { code: "noMailbox", params: { owner: "Ada" } },
    });
    expect(
      failure(planEmail(world({ ok: false, reason: "expired" }), eff(), "ada", 0, null)),
    ).toMatchObject({
      error: "mailbox_expired",
      why: { code: "mailboxExpired" },
    });
    expect(
      failure(planEmail(world({ ok: false, reason: "no_scope" }), eff(), "ada", 0, null)),
    ).toMatchObject({
      error: "mailbox_scope",
      why: { code: "mailboxScope", params: { owner: "Ada" } },
    });
  });

  it("un destinatario che non è un indirizzo: `invalid_address`", () => {
    expect(
      failure(planEmail(world(ok), eff({ to: "non un indirizzo" }), "ada", 0, null)),
    ).toMatchObject({
      error: "invalid_address",
      why: { code: "invalidAddress", params: { to: "non un indirizzo" } },
    });
  });

  it("il tetto si controlla prima della casella", () => {
    const p = planEmail(
      world({ ok: false, reason: "none" }),
      eff(),
      "ada",
      AUTOMATION_LIMITS.emailsPerRun,
      null,
    );
    expect(failure(p)?.error).toBe("email_limit");
  });
});

describe("la stessa conversazione", () => {
  it("le email allo stesso indirizzo (senza badare a maiuscole e spazi) stanno nella conversazione della prima", () => {
    const sent = [
      { stepId: "a", to: "Cliente@Example.com" },
      { stepId: "b", to: "altro@example.com" },
      { stepId: "c", to: "cliente@example.com" },
    ];
    expect(sameConversation(sent, " cliente@example.com")?.stepId).toBe("a");
    expect(sameConversation(sent, "nuovo@example.com")).toBeUndefined();
  });
});

describe("review F2, M4: un indirizzo è UNO", () => {
  it("niente separatori né parti di un'intestazione: un «To» preso dal testo non diventa due destinatari", () => {
    for (const bad of ["a,evil@x.y", "a@b.it,evil@x.y", "a@b.it;c@d.it", "<a@b.it>", '"a"@b.it', "a(b)@c.it", "a@[1.2.3.4]", "a b@c.it", "a@b"]) expect(EMAIL_ADDRESS.test(bad), bad).toBe(false);
    for (const good of ["cliente@b.it", "nome.cognome+tag@dominio.example.com", "o'brien@b.ie", "a_b-c@d-e.it"]) expect(EMAIL_ADDRESS.test(good), good).toBe(true);
  });
});

