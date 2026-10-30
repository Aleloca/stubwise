import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { roleIdOf } from "../../data/access/index";
import { accessState } from "../../data/access/index";
import { admin, auth, me, resetApi, setLatency } from "../../data/api";
import { markReauthenticated } from "../../data/auth/reauth";
import { useSetInstanceRole } from "../../data/queries";
import { PEOPLE } from "../../data/seed/people";
import { NO_SESSION_PERSON_ID, getSessionPersonId, setSessionPersonId } from "../../data/session";
import { advanceNow, state } from "../../data/store";
import { viewerFor } from "../../data/viewer";
import { ReauthHost } from "../../layout/ReauthDialog";
import { resetReauthForTest, useReauth } from "../../layout/useReauth";
import { renderRoute } from "../../test/renderRoute";
import { renderWithData } from "../../test/renderWithData";
import { ToastRegion } from "../../tasks-ui/Toast";

// L'ingresso e la riconferma (area 9a, Task 6, shape `entry.md`).

beforeEach(() => {
  resetApi();
  setLatency(0);
  resetReauthForTest();
});
afterEach(() => resetApi());

const DAY = 86_400_000;

/** Fuori: la sessione di Giulia si chiude, e l'app parte dal login. */
async function signedOut() {
  await auth.logout();
}

async function signIn(email: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Email"), email);
  await user.type(screen.getByLabelText("Password"), "stubwise");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

const accessRole = (personId: string) =>
  accessState().people.find((p) => p.personId === personId)?.instanceRoleId;

describe("login", () => {
  it("fuori, l'app porta al login; Laura: password, codice 123456, Home come Laura", async () => {
    await signedOut();
    const router = renderRoute("/home");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign in to Stubwise" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    // Fuori dall'intelaiatura: niente binario.
    expect(document.querySelector('[data-zone="rail"]')).toBeNull();
    const user = await signIn("laura.costa@example.com");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Two-step verification" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Signing in as laura\.costa@example\.com/)).toBeInTheDocument();
    // Alla sesta cifra si invia da solo.
    await user.type(screen.getByLabelText("Code"), "123456");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/home");
    expect(getSessionPersonId()).toBe("p-laura");
  });

  it("una password sbagliata dice la stessa frase di un'email inesistente; l'email resta", async () => {
    await signedOut();
    renderRoute("/login");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("Email"), "laura.costa@example.com");
    await user.type(screen.getByLabelText("Password"), "nope");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The email or password is wrong.");
    expect(screen.getByLabelText("Email")).toHaveValue("laura.costa@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await user.clear(screen.getByLabelText("Email"));
    await user.type(screen.getByLabelText("Email"), "nobody@example.com");
    await user.type(screen.getByLabelText("Password"), "stubwise");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("The email or password is wrong."),
    );
    expect(screen.queryByText("Two-step verification")).toBeNull();
  });

  it("codice sbagliato: errore in parole, il contatore dal secondo; al quinto bloccato", async () => {
    await signedOut();
    renderRoute("/login");
    const user = await signIn("laura.costa@example.com");
    const code = await screen.findByLabelText("Code");
    await user.type(code, "000000");
    expect(await screen.findByText("That code didn't work.")).toBeInTheDocument();
    expect(code).toHaveValue("");
    await user.type(code, "000000");
    expect(await screen.findByText("That code didn't work. 3 tries left.")).toBeInTheDocument();
    for (let i = 0; i < 3; i++) {
      await user.type(code, "000000");
      await waitFor(() => expect(code).toHaveValue(""));
    }
    const locked = await screen.findByText(
      /Too many wrong codes\. Two-step verification is locked until \d\d:\d\d\./,
    );
    expect(locked).toBeInTheDocument();
    expect(code).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use a passkey" })).toBeDisabled();
    // Anche il codice giusto non passa: il blocco è un blocco.
    expect(await auth.loginSecondFactor({ method: "totp", code: "123456" })).toMatchObject({
      error: "locked",
    });
    expect(getSessionPersonId()).not.toBe("p-laura");
  });

  it("una passkey fallita lo dice; con la passkey si entra", async () => {
    await signedOut();
    renderRoute("/login");
    const user = await signIn("laura.costa@example.com");
    await user.click(await screen.findByRole("button", { name: "Use a passkey" }));
    expect(screen.getByText("Use the passkey on this device.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Simulate a failed passkey" }));
    expect(
      await screen.findByText("The passkey didn't work. Try again or use a code."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use passkey" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
  });

  it("Sara entra senza secondo passo", async () => {
    await signedOut();
    renderRoute("/login");
    await signIn("sara.montanari@example.com");
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(getSessionPersonId()).toBe("p-sara");
  });

  it("«Sign in as» riempie il modulo ma non invia; le persone disattivate non ci sono", async () => {
    await signedOut();
    renderRoute("/login");
    const box = await screen.findByRole("region", { name: "Prototype only" });
    expect(within(box).getByText("stubwise")).toBeInTheDocument();
    expect(within(box).getByText("123456")).toBeInTheDocument();
    await userEvent.click(await within(box).findByRole("button", { name: "Laura" }));
    expect(screen.getByLabelText("Email")).toHaveValue("laura.costa@example.com");
    expect(screen.getByLabelText("Password")).toHaveValue("stubwise");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Sign in to Stubwise");
    expect(within(box).queryByRole("button", { name: "Simone" })).toBeNull();
  });
});

describe("registrazione su invito", () => {
  async function inviteLink() {
    setSessionPersonId("p-roberta");
    markReauthenticated("p-roberta");
    const r = await admin.createInvite({
      email: "nora.nuova@example.com",
      instanceRoleId: roleIdOf("user"),
      projects: [{ projectId: "prj-acq", roleId: roleIdOf("developer") }],
    });
    setSessionPersonId("p-giulia");
    return (r as { link: string }).link.split("invite=")[1]!;
  }

  it("un invito valido dice chi invita e cosa dà, registra e porta dentro", async () => {
    const token = await inviteLink();
    await signedOut();
    const router = renderRoute(`/register/${token}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Join Stubwise" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Roberta Fontana invited you.")).toBeInTheDocument();
    expect(screen.getByText("ACQ")).toBeInTheDocument();
    expect(screen.getByText("Developer")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("nora.nuova@example.com");
    expect(screen.getByLabelText("Email")).toHaveAttribute("readonly");
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Your name"), "Nora Nuova");
    await user.type(screen.getByLabelText("Password"), "a-long-one");
    await user.type(screen.getByLabelText("Confirm password"), "a-long-two");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("The passwords don't match.")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Confirm password"));
    await user.type(screen.getByLabelText("Confirm password"), "a-long-one");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/home");
    const nora = PEOPLE.find((p) => p.name === "Nora Nuova")!;
    expect(getSessionPersonId()).toBe(nora.id);
    expect(await screen.findByText("Welcome, Nora. You're in ACQ.")).toBeInTheDocument();
  });

  it("uno scaduto lo dice, con chi l'aveva mandato; nessun modulo", async () => {
    const token = await inviteLink();
    advanceNow(8 * DAY);
    renderRoute(`/register/${token}`);
    expect(
      await screen.findByRole("heading", { level: 1, name: "This invite has expired" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Roberta Fontana invited you on .*Ask Roberta for a new one\./),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toBeInTheDocument();
  });

  it("un link inventato non rivela niente", async () => {
    renderRoute("/register/made-up");
    expect(
      await screen.findByText("This invite link isn't valid. Ask whoever sent it for a new one."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Roberta/)).toBeNull();
  });

  it("«Try an invite» dal login apre l'invito in sospeso del seme", async () => {
    await signedOut();
    renderRoute("/login");
    const box = await screen.findByRole("region", { name: "Prototype only" });
    await userEvent.click(within(box).getByRole("button", { name: "pending" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Join Stubwise" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("ines.ricci@example.com");
  });
});

describe("uscita, istanza vuota e primo avvio", () => {
  it("Sign out porta al login, e «nessuno» resta tale", async () => {
    const router = renderRoute("/home");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Profile and settings" }));
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Sign in to Stubwise" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(getSessionPersonId()).toBe(NO_SESSION_PERSON_ID);
    // «Nessuno» ha un `Viewer` suo, senza permessi: non quello della persona di default.
    const nobody = viewerFor(NO_SESSION_PERSON_ID);
    expect(nobody.personId).toBe(NO_SESSION_PERSON_ID);
    expect(nobody.instancePermissions).toEqual([]);
    // Un'altra rotta dell'app riporta al login.
    await act(() => router.navigate({ to: "/projects" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(getSessionPersonId()).toBe(NO_SESSION_PERSON_ID);
  });

  it("Reset to empty instance (a due tempi) → setup → Home vuota, da full admin", async () => {
    const router = renderRoute("/home");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Profile and settings" }));
    const reset = screen.getByRole("button", { name: "Reset to empty instance" });
    await user.click(reset);
    // Il primo clic arma soltanto.
    expect(PEOPLE.length).toBeGreaterThan(1);
    await user.click(screen.getByRole("button", { name: "Reset — sure?" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Set up Stubwise" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/setup");
    expect(getSessionPersonId()).toBe(NO_SESSION_PERSON_ID);
    // Ogni altra rotta porta qui.
    await act(() => router.navigate({ to: "/login" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/setup"));
    await user.type(await screen.findByLabelText("Your name"), "Ada Prima");
    await user.type(screen.getByLabelText("Email"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "a-long-one");
    await user.type(screen.getByLabelText("Confirm password"), "a-long-one");
    await user.click(screen.getByRole("button", { name: "Create the admin account" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(await screen.findByText("You're the instance's full admin.")).toBeInTheDocument();
    const ada = PEOPLE.find((p) => p.name === "Ada Prima")!;
    expect(getSessionPersonId()).toBe(ada.id);
    expect(accessRole(ada.id)).toBe(roleIdOf("admin"));
    // Ora `/setup` riporta dentro.
    await act(() => router.navigate({ to: "/setup" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/home"));
  });
});

// --- la riconferma ----------------------------------------------------------

/** Un'azione delicata qualunque, come la userà una pagina: il cambio di ruolo d'istanza di Marco. */
function ChangeMarcosRole() {
  const reauth = useReauth();
  const setRole = useSetInstanceRole();
  const [outcome, setOutcome] = useState("");
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          const r = await reauth(() => setRole.mutateAsync(["p-marco", roleIdOf("au-1")]), {
            action: "change Marco Bellini's instance role",
          });
          setOutcome(r.ok ? "done" : r.error);
        }}
      >
        Change role…
      </button>
      <output>{outcome}</output>
      <ReauthHost />
      <ToastRegion />
    </>
  );
}

describe("riconferma", () => {
  it("chiede il codice nominando l'azione, e la ripete da sola", async () => {
    renderWithData(<ChangeMarcosRole />, { personId: "p-roberta" });
    const before = accessRole("p-marco");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Change role…" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(dialog).toHaveAccessibleDescription(
      "To change Marco Bellini's instance role, enter a code from your authenticator app.",
    );
    expect(
      within(dialog).getByText("You won't be asked again for 10 minutes."),
    ).toBeInTheDocument();
    // Niente è cambiato finché non c'è il codice.
    expect(accessRole("p-marco")).toBe(before);
    await user.type(within(dialog).getByLabelText("Code"), "000000");
    expect(await within(dialog).findByText("That code didn't work.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Code"), "123456");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(accessRole("p-marco")).toBe(roleIdOf("au-1"));
  });

  it("chiuso (Cancel o Esc) non cambia niente, e lo dice", async () => {
    renderWithData(<ChangeMarcosRole />, { personId: "p-roberta" });
    const before = JSON.stringify(accessState());
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Change role…" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Nothing was changed.")).toBeInTheDocument();
    expect(await screen.findByText("reauth_cancelled")).toBeInTheDocument();
    expect(JSON.stringify(accessState())).toBe(before);
    await waitFor(() => expect(trigger).toHaveFocus());
    // Esc fa lo stesso.
    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Confirm it's you" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(JSON.stringify(accessState())).toBe(before);
  });

  it("dentro la finestra di grazia non chiede niente", async () => {
    markReauthenticated("p-roberta");
    renderWithData(<ChangeMarcosRole />, { personId: "p-roberta" });
    await userEvent.click(screen.getByRole("button", { name: "Change role…" }));
    expect(await screen.findByText("done")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/** Un'azione delicata di chiunque: un token personale. */
function CreateToken() {
  const reauth = useReauth();
  const [outcome, setOutcome] = useState("");
  return (
    <>
      <button
        type="button"
        onClick={async () => {
          const r = await reauth(() => me.createToken({ name: "Laptop", expiresAt: null }), {
            action: "create a personal token",
          });
          setOutcome(r.ok ? "created" : r.error);
        }}
      >
        Create token
      </button>
      <output>{outcome}</output>
      <ReauthHost />
      <ToastRegion />
    </>
  );
}

describe("iscrizione al volo (Sara, senza secondo fattore)", () => {
  it("tre passi: chiave, primo codice, codici di backup salvati; poi l'azione riparte", async () => {
    renderWithData(<CreateToken />, { personId: "p-sara" });
    setSessionPersonId("p-sara");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(
      await within(dialog).findByText(
        "This action needs two-step verification, and you haven't set it up yet. It takes a minute.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Prototype: this QR code is made up.")).toBeInTheDocument();
    await user.click(await within(dialog).findByRole("button", { name: "Next" }));
    await user.type(within(dialog).getByLabelText("Code"), "123456");
    const codes = await within(dialog).findByRole("list", { name: "Backup codes" });
    expect(within(codes).getAllByRole("listitem")).toHaveLength(10);
    const proceed = within(dialog).getByRole("button", { name: "Continue" });
    expect(proceed).toBeDisabled();
    await user.click(within(dialog).getByLabelText("I've saved them"));
    await user.click(proceed);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("created")).toBeInTheDocument();
    expect(state.tokens.some((t) => t.personId === "p-sara" && t.name === "Laptop")).toBe(true);
  });

  it("annullata a metà non attiva niente", async () => {
    renderWithData(<CreateToken />, { personId: "p-sara" });
    setSessionPersonId("p-sara");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Create token" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(await within(dialog).findByRole("button", { name: "Next" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByText("Two-step verification wasn't set up. Nothing was changed."),
    ).toBeInTheDocument();
    expect(accessState().people.find((p) => p.personId === "p-sara")?.secondFactor).toBeNull();
    expect(state.tokens.some((t) => t.personId === "p-sara")).toBe(false);
  });
});
