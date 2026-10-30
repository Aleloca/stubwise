import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admin, auth, resetApi, setLatency } from "../../data/api";
import { markReauthenticated } from "../../data/auth/reauth";
import { resetTokenOf } from "../../data/auth/resetPassword";
import { setSessionPersonId } from "../../data/session";
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
    await user.type(screen.getByLabelText("New password"), "brand-new-pass");
    await user.type(screen.getByLabelText("Confirm password"), "brand-new-pass");
    await user.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText("Password changed. Sign in with the new one.")).toBeVisible();
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(state.sessions.filter((s) => s.personId === MARCO)).toEqual([]);
  });

  it("riaperto dopo l'uso: «already used», niente modulo", async () => {
    const link = await linkForMarco();
    const token = resetTokenOf(link);
    expect(await auth.resetPassword(token, { password: "brand-new-pass" })).toEqual({ ok: true });
    renderRoute(`/reset-password/${token}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "This link was already used" }),
    ).toBeVisible();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("un link inventato: «isn't valid», senza nomi", async () => {
    renderRoute("/reset-password/made-up-token");
    expect(
      await screen.findByRole("heading", { level: 1, name: "This link isn't valid" }),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain("Marco");
  });
});
