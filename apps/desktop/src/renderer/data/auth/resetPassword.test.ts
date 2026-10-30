import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admin, auth, me, resetApi, setLatency } from "../api";
import { setSessionPersonId } from "../session";
import { advanceNow, state } from "../store";
import { markReauthenticated } from "./reauth";
import { entryLinkOf, resetTokenOf } from "./resetPassword";

// Il link di reset della password (area 9a, come
// `apps/web/src/routes/reset-password.tsx`): Roberta lo crea per Marco in
// People, Marco lo apre. Vale un'ora e una volta; usato, la password cambia
// e ogni sessione di Marco si chiude.

const MARCO = "p-marco";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

/** Roberta crea un link per Marco; il token della rotta `/reset-password/$token`. */
async function linkForMarco(): Promise<string> {
  setSessionPersonId("p-roberta");
  markReauthenticated("p-roberta");
  const r = await admin.createPasswordResetLink(MARCO);
  if (!r.ok) throw new Error(r.error);
  return resetTokenOf(r.link);
}

describe("link di reset", () => {
  it("valido: la password cambia, le sessioni di Marco si chiudono, il link non vale più", async () => {
    const token = await linkForMarco();
    expect(state.sessions.some((s) => s.personId === MARCO)).toBe(true);
    const others = state.sessions.filter((s) => s.personId !== MARCO).length;
    expect(await auth.getResetLink(token)).toEqual({ status: "valid" });
    expect(await auth.resetPassword(token, { password: "short" })).toEqual({
      ok: false,
      error: "invalid_input",
      reason: "password",
    });
    expect(await auth.resetPassword(token, { password: "new-password-1" })).toEqual({
      ok: true,
      signedOutHere: false,
    });
    expect(state.sessions.filter((s) => s.personId === MARCO)).toEqual([]);
    expect(state.sessions).toHaveLength(others);
    // La password nuova apre il login (al secondo passo: Marco ha il secondo fattore); la vecchia no.
    await auth.logout();
    expect(
      await auth.login({ email: "marco.bellini@example.com", password: "new-password-1" }),
    ).toMatchObject({ ok: true });
    expect(
      await auth.login({ email: "marco.bellini@example.com", password: "stubwise" }),
    ).toMatchObject({ ok: false });
    // Una volta sola; usato e scaduto rispondono uguale, come il server (niente oracolo).
    expect(await auth.getResetLink(token)).toEqual({ status: "spent" });
    expect(await auth.resetPassword(token, { password: "another-one-2" })).toEqual({
      ok: false,
      error: "spent",
    });
  });

  it("scade dopo un'ora", async () => {
    const token = await linkForMarco();
    advanceNow(61 * 60_000);
    expect(await auth.getResetLink(token)).toEqual({ status: "spent" });
    expect(await auth.resetPassword(token, { password: "new-password-1" })).toEqual({
      ok: false,
      error: "spent",
    });
  });

  it("un link nuovo fa smettere il precedente; un link inventato non dice niente", async () => {
    const first = await linkForMarco();
    const second = await linkForMarco();
    expect(await auth.getResetLink(first)).toEqual({ status: "invalid" });
    expect(await auth.getResetLink(second)).toEqual({ status: "valid" });
    expect(await auth.getResetLink("made-up")).toEqual({ status: "invalid" });
  });

  it("cambiare la propria password annulla il link di reset aperto (come il server)", async () => {
    const token = await linkForMarco();
    setSessionPersonId(MARCO);
    expect(await me.changePassword({ current: "stubwise", next: "brand-new-pass" })).toMatchObject({
      ok: true,
    });
    expect(await auth.getResetLink(token)).toEqual({ status: "invalid" });
    expect(await auth.resetPassword(token, { password: "taken-over-1" })).toMatchObject({
      ok: false,
    });
  });

  it("disattivare dimentica il link: riattivando, quello di prima non torna buono", async () => {
    const token = await linkForMarco();
    expect(await admin.deactivatePerson(MARCO, {})).toMatchObject({ ok: true });
    expect(await admin.reactivatePerson(MARCO)).toMatchObject({ ok: true });
    expect(await auth.getResetLink(token)).toEqual({ status: "invalid" });
    expect(state.resetLinks.filter((l) => l.personId === MARCO)).toEqual([]);
  });

  it("aprire il proprio link da dentro chiude anche questa sessione: si è fuori", async () => {
    const token = await linkForMarco();
    // Marco è dentro, e apre il suo link.
    setSessionPersonId(MARCO);
    await auth.login({ email: "marco.bellini@example.com", password: "stubwise" });
    await auth.loginSecondFactor({ method: "totp", code: "123456" });
    expect(await auth.getEntry()).toEqual({ stage: "in" });
    expect(await auth.resetPassword(token, { password: "new-password-1" })).toEqual({
      ok: true,
      signedOutHere: true,
    });
    expect(await auth.getEntry()).toEqual({ stage: "out" });
    expect(state.sessions.filter((s) => s.personId === MARCO)).toEqual([]);
  });

  it("il campo unico del login riconosce un link di reset e uno d'invito [R4]", async () => {
    const reset = await (async () => {
      setSessionPersonId("p-roberta");
      markReauthenticated("p-roberta");
      const r = await admin.createPasswordResetLink(MARCO);
      if (!r.ok) throw new Error(r.error);
      return r.link;
    })();
    expect(entryLinkOf(reset)).toEqual({ kind: "reset", token: resetTokenOf(reset) });
    expect(entryLinkOf("https://x.example/register?invite=abc ")).toEqual({
      kind: "invite",
      token: "abc",
    });
    expect(entryLinkOf("bare-token")).toEqual({ kind: "invite", token: "bare-token" });
    expect(entryLinkOf("   ")).toBeNull();
  });

  it("una persona disattivata dopo la creazione non rientra dal link", async () => {
    const token = await linkForMarco();
    expect(await admin.deactivatePerson(MARCO, {})).toMatchObject({ ok: true });
    expect(await auth.resetPassword(token, { password: "new-password-1" })).toEqual({
      ok: false,
      error: "invalid",
    });
  });
});
