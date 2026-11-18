import { act, screen } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth, me, resetApi, setLatency } from "../../data/api";
import { __secretValuesForTest } from "../../data/admin/secrets";
import { markReauthenticated } from "../../data/auth/reauth";
import { setSessionPersonId } from "../../data/session";
import { renderRoute } from "../../test/renderRoute";

// La pagina del link del cambio d'email (area 9, R2; il server la serve a
// `<PUBLIC_URL>/app/#/email-change/<token>`): pubblica, senza sessione. NON
// si conferma all'apertura (gli scanner della posta aprono i link ed
// eseguono il JS): mostra la nuova email e conferma solo al clic. Un link sbagliato,
// scaduto, usato o annullato dà UNA frase sola, come il server.

const SARA = "p-sara";
const NEW = "sara@new.example.com";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

async function linkForSara(email = NEW): Promise<string> {
  setSessionPersonId(SARA);
  markReauthenticated(SARA);
  const r = await me.requestEmailChange(email);
  if (!r.ok) throw new Error(r.error);
  const token = __secretValuesForTest()
    .find((s) => s.kind === "email_change_link")!
    .values.at(-1)!;
  await auth.logout();
  return token;
}

describe("/email-change/$token", () => {
  it("aprirlo NON conferma (gli scanner della posta aprono i link): mostra la nuova email e il bottone", async () => {
    const token = await linkForSara();
    renderRoute(`/email-change/${token}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Confirm your new sign-in email" }),
    ).toBeVisible();
    expect(screen.getByText(`Your sign-in email will become ${NEW}.`)).toBeVisible();
    expect(screen.getByRole("button", { name: "Confirm email change" })).toBeVisible();
    // Niente è cambiato: si entra ancora con la vecchia.
    expect(
      (await auth.login({ email: "sara.montanari@example.com", password: "stubwise" })).ok,
    ).toBe(true);
    expect((await auth.login({ email: NEW, password: "stubwise" })).ok).toBe(false);
  });

  it("il clic conferma: la nuova email e il login", async () => {
    const user = userEvent.setup();
    const token = await linkForSara();
    renderRoute(`/email-change/${token}`);
    await user.click(await screen.findByRole("button", { name: "Confirm email change" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign-in email changed" }),
    ).toBeVisible();
    expect(screen.getByText(`From now on you sign in with ${NEW}.`)).toBeVisible();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toBeVisible();
    expect((await auth.login({ email: NEW, password: "stubwise" })).ok).toBe(true);
  });

  it("tornare alla finestra non rilegge il link (review F1, M3): una lettura per visita", async () => {
    const token = await linkForSara();
    const reads = vi.spyOn(me, "getEmailChangeLink");
    renderRoute(`/email-change/${token}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Confirm your new sign-in email" }),
    ).toBeVisible();
    expect(reads).toHaveBeenCalledTimes(1);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(reads).toHaveBeenCalledTimes(1);
    focusManager.setFocused(undefined);
    reads.mockRestore();
  });

  it("un link usato, annullato o inventato: una frase sola, senza nomi e senza bottone", async () => {
    const token = await linkForSara();
    expect((await me.confirmEmailChange(token)).ok).toBe(true);
    for (const t of [token, "made-up-token"]) {
      document.body.replaceChildren();
      renderRoute(`/email-change/${t}`);
      expect(
        await screen.findByRole("heading", { level: 1, name: "This link isn't valid" }),
      ).toBeVisible();
      expect(screen.queryByText(new RegExp(NEW))).toBeNull();
      expect(screen.queryByRole("button", { name: "Confirm email change" })).toBeNull();
    }
  });

  it("l'indirizzo preso nel frattempo da un'altra persona: al clic lo dice, e l'email resta quella di prima", async () => {
    const user = userEvent.setup();
    const token = await linkForSara("taken-later@example.com");
    const { PEOPLE } = await import("../../data/seed/people");
    PEOPLE.find((p) => p.id === "p-marco")!.email = "taken-later@example.com";
    renderRoute(`/email-change/${token}`);
    await user.click(await screen.findByRole("button", { name: "Confirm email change" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "That email is taken" }),
    ).toBeVisible();
    expect(
      (await auth.login({ email: "sara.montanari@example.com", password: "stubwise" })).ok,
    ).toBe(true);
  });
});
