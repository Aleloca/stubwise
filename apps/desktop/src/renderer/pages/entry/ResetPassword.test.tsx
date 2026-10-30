import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admin, auth, resetApi, setLatency } from "../../data/api";
import { markReauthenticated } from "../../data/auth/reauth";
import { resetTokenOf } from "../../data/auth/resetPassword";
import { NO_SESSION_PERSON_ID, getSessionPersonId, setSessionPersonId } from "../../data/session";
import { state } from "../../data/store";
import { renderRoute } from "../../test/renderRoute";

// La schermata del link di reset (area 9a, come
// `apps/web/src/routes/reset-password.tsx`): Roberta crea il link per Marco,
// Marco lo apre dal login (riquadro «Prototype only», «Paste a reset link»).

const MARCO = "p-marco";

beforeEach(() => {
  setLatency(0);
  resetApi();
});
afterEach(() => resetApi());

async function linkForMarco(): Promise<string> {
  setSessionPersonId("p-roberta");
  markReauthenticated("p-roberta");
  const r = await admin.createPasswordResetLink(MARCO);
  if (!r.ok) throw new Error(r.error);
  return r.link;
}

describe("/reset-password/$token", () => {
  it("dal login si incolla il link; la password nuova chiude le sessioni e porta al login", async () => {
    const user = userEvent.setup();
    const link = await linkForMarco();
    await auth.logout();
    const router = renderRoute("/login");
    await user.type(await screen.findByLabelText("Password reset link"), link);
    await user.click(screen.getAllByRole("button", { name: "Open" }).at(-1)!);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Choose a new password" }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe(`/reset-password/${resetTokenOf(link)}`);
    // Anche il modulo valido ha la sua uscita [R5].
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute(
      "href",
      expect.stringMatching(/\/login$/),
    );
    await user.type(screen.getByLabelText("New password"), "brand-new-pass");
    await user.type(screen.getByLabelText("Confirm password"), "brand-new-pass");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("Password changed. Sign in with the new one.")).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(state.sessions.filter((s) => s.personId === MARCO)).toEqual([]);
  });

  it("riaperto dopo l'uso: «doesn't work any more» (come scaduto), niente modulo", async () => {
    const link = await linkForMarco();
    const token = resetTokenOf(link);
    expect(await auth.resetPassword(token, { password: "brand-new-pass" })).toMatchObject({
      ok: true,
    });
    renderRoute(`/reset-password/${token}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "This link doesn't work any more" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("il proprio link aperto da dentro: la sessione si chiude e l'app esce", async () => {
    const user = userEvent.setup();
    const token = resetTokenOf(await linkForMarco());
    setSessionPersonId(MARCO);
    await auth.login({ email: "marco.bellini@example.com", password: "stubwise" });
    await auth.loginSecondFactor({ method: "totp", code: "123456" });
    const router = renderRoute(`/reset-password/${token}`, MARCO);
    await user.type(await screen.findByLabelText("New password"), "brand-new-pass");
    await user.type(screen.getByLabelText("Confirm password"), "brand-new-pass");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(await auth.getEntry()).toEqual({ stage: "out" });
    expect(getSessionPersonId()).toBe(NO_SESSION_PERSON_ID);
  });

  it("un link inventato: «isn't valid», senza nomi", async () => {
    renderRoute("/reset-password/made-up-token");
    expect(
      await screen.findByRole("heading", { level: 1, name: "This link isn't valid" }),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain("Marco");
    // L'unica uscita si legge come un link già a riposo, non solo per il colore (B2).
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveClass("underline");
  });
});
