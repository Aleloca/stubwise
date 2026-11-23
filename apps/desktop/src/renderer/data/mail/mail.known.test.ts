import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { strangersTo } from "../../test/strangers";
import { mail, resetApi, setLatency } from "../api";
import { MAIL_CASES } from "../seed/mail";
import { PEOPLE } from "../seed/people";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import type { MailProposal } from "../types";

// Registro, A11 r.1414, scelta di 46 (lotto 3, posta e calendario): chi
// compare nelle intestazioni di un'email che chi guarda ha ricevuto (mittente,
// `to`, `cc`) è conosciuto PER QUELLA PROPOSTA; gli altri, se chi guarda non
// li conosce, sono `hidden-<n>` e senza nome: chi l'ha decisa, passata o ha
// scelto il progetto. Gli incaricati delle azioni restano veri, come sul
// server: servono al gesto «Aggiungere come Contributor?».

const LAURA = "p-laura"; // in cc dell'email condivisa
const nameOf = (id: string) => PEOPLE.find((p) => p.id === id)!.name;
const message = () => state.mailMessages.find((m) => m.id === MAIL_CASES.shared)!;

function addProposal(extra: Partial<MailProposal>): string {
  const id = `mp-known-${state.mailProposals.length}`;
  state.mailProposals.push({
    id,
    source: "email",
    sourceId: message().messageId,
    projectId: "prj-aud",
    actions: [{ fn: "createTask", args: { title: "VAT column", assigneeId: null } }],
    excerpt: "We need the VAT number column.",
    createdAt: "2026-10-25T10:00:00Z",
    status: "open",
    decidedById: null,
    decidedAt: null,
    resultCodes: [],
    error: null,
    handedAt: null,
    handedById: null,
    ...extra,
  } as MailProposal);
  return id;
}

/** Uno sconosciuto a Laura che non sta nelle intestazioni dell'email condivisa. */
function outsiderOfHeaders(): string {
  const m = message();
  const inHeaders = new Set([m.from, ...m.to, ...(m.cc ?? [])].map((a) => a.personId));
  const [who] = strangersTo(LAURA);
  expect(inHeaders.has(who!)).toBe(false);
  return who!;
}

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("le proposte della posta senza id né nome di chi non si conosce (r.1414)", () => {
  it("chi l'ha decisa e chi l'ha passata: segnaposto, senza nome", async () => {
    const who = outsiderOfHeaders();
    expect(who).toBeDefined();
    const id = addProposal({
      status: "ignored",
      decidedById: who,
      decidedAt: "2026-10-25T11:00:00Z",
      handedById: who,
      handedAt: "2026-10-25T10:30:00Z",
    });
    setSessionPersonId(LAURA);
    const view = await mail.getMailProposal(id);
    expect(view.decidedBy).toEqual({ personId: "hidden-1", name: "" });
    expect(view.proposal.decidedById).toBe("hidden-1");
    expect(view.proposal.handedById).toBe("hidden-1");
    expect(JSON.stringify(view)).not.toContain(who);
    expect(JSON.stringify(view)).not.toContain(nameOf(who));
  });

  it("già decisa da uno sconosciuto: `already_handled` col segnaposto", async () => {
    const who = outsiderOfHeaders();
    const id = addProposal({
      status: "ignored",
      decidedById: who,
      decidedAt: "2026-10-25T11:00:00Z",
    });
    setSessionPersonId(LAURA);
    const err = await mail.confirmMailProposal(id).then(
      () => null,
      (e: Error & { byId?: string | null }) => e,
    );
    expect(err?.message).toBe("already_handled");
    expect(err?.byId).toBe("hidden-1");
  });

  it("chi sta nelle intestazioni dell'email è conosciuto per quella proposta", async () => {
    const who = outsiderOfHeaders();
    message().cc = [
      ...(message().cc ?? []),
      { personId: who, name: nameOf(who), email: "x@example.com" },
    ] as never;
    const id = addProposal({
      status: "ignored",
      decidedById: who,
      decidedAt: "2026-10-25T11:00:00Z",
    });
    setSessionPersonId(LAURA);
    const view = await mail.getMailProposal(id);
    expect(view.decidedBy).toEqual({ personId: who, name: nameOf(who) });
  });
});
