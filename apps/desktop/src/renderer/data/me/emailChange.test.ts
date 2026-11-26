import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { admin, auth, me, resetApi, setLatency } from "../api";
import { __secretValuesForTest } from "../admin/secrets";
import { markReauthenticated } from "../auth/reauth";
import { setSessionPersonId } from "../session";
import { advanceNow, state } from "../store";

// Il cambio dell'email di login (area 9, R2; design 1.6, E-1 = a): la
// persona chiede, con la riconferma; il link arriva al nuovo indirizzo (qui
// simulato) e vale 24 ore, una volta; fino al clic si entra con la vecchia.
// Senza trasporto la persona non può, e lo fa un admin (`users.manage`),
// subito e senza verifica.

const SARA = "p-sara";
const OLD = "sara.montanari@example.com";
const NEW = "sara@new.example.com";
const as = (id: string) => setSessionPersonId(id);
const loginOk = async (email: string) =>
  (await auth.login({ email, password: "stubwise" })).ok === true;

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("la persona cambia la sua email", () => {
  it("senza riconferma: reauth_required, niente in attesa", async () => {
    as(SARA);
    state.reauth.delete(SARA);
    expect(await me.requestEmailChange(NEW)).toEqual({ ok: false, error: "reauth_required" });
    expect((await me.getMyProfile()).pendingEmail).toBeNull();
  });

  it("in attesa fino al clic: si entra con la vecchia; dopo il clic solo con la nuova", async () => {
    as(SARA);
    markReauthenticated(SARA);
    const sessions = state.sessions.filter((s) => s.personId === SARA).length;
    expect(await me.requestEmailChange(NEW)).toMatchObject({ ok: true });
    expect((await me.getMyProfile()).pendingEmail).toMatchObject({ email: NEW });
    expect((await me.getMyProfile()).email).toBe(OLD);
    expect(await loginOk(OLD)).toBe(true);
    expect(await loginOk(NEW)).toBe(false);

    as(SARA);
    expect(await me.simulateEmailChangeLink()).toEqual({ ok: true, email: NEW });
    // Una volta sola.
    expect(await me.simulateEmailChangeLink()).toEqual({
      ok: false,
      error: "invalid",
      reason: "link",
    });
    as(SARA);
    expect((await me.getMyProfile()).email).toBe(NEW);
    expect((await me.getMyProfile()).pendingEmail).toBeNull();
    expect(await loginOk(NEW)).toBe(true);
    expect(await loginOk(OLD)).toBe(false);
    // Sessioni e secondo fattore intatti; la traccia e l'avviso.
    expect(state.sessions.filter((s) => s.personId === SARA).length).toBe(sessions);
    expect(state.securityEvents.find((e) => e.kind === "email_changed")).toMatchObject({
      personId: SARA,
      byId: null,
    });
    expect(state.notifications.at(-1)).toMatchObject({
      kind: "security.alert",
      recipientIds: [SARA],
    });
  });

  it("il link vale una volta e 24 ore; «Annulla» lo spegne; una seconda richiesta sostituisce la prima", async () => {
    as(SARA);
    markReauthenticated(SARA);
    await me.requestEmailChange(NEW);
    expect(await me.cancelEmailChange()).toEqual({ ok: true });
    expect((await me.getMyProfile()).pendingEmail).toBeNull();
    expect(await me.simulateEmailChangeLink()).toEqual({
      ok: false,
      error: "invalid",
      reason: "link",
    });

    await me.requestEmailChange("first@new.example.com");
    await me.requestEmailChange(NEW);
    expect((await me.getMyProfile()).pendingEmail).toMatchObject({ email: NEW });

    advanceNow((24 * 60 + 1) * 60_000);
    as(SARA);
    expect(await me.simulateEmailChangeLink()).toEqual({
      ok: false,
      error: "invalid",
      reason: "link",
    });
    expect((await me.getMyProfile()).email).toBe(OLD);
  });

  it("un indirizzo già di un'altra persona o di un invito pendente: email_taken; uno non valido: email", async () => {
    as(SARA);
    markReauthenticated(SARA);
    expect(await me.requestEmailChange("laura.costa@example.com")).toEqual({
      ok: false,
      error: "invalid",
      reason: "email_taken",
    });
    const invite = state.invites.find(
      (i) => !i.acceptedAt && !i.revokedAt && i.expiresAt > "2000",
    )!;
    expect(await me.requestEmailChange(invite.email.toUpperCase())).toMatchObject({
      reason: "email_taken",
    });
    expect(await me.requestEmailChange("nope")).toMatchObject({ reason: "email" });
    expect((await me.getMyProfile()).pendingEmail).toBeNull();
  });

  it("senza trasporto: email_transport_unavailable, e il profilo lo dice", async () => {
    as(SARA);
    markReauthenticated(SARA);
    me.setEmailTransportForPrototype(false);
    expect((await me.getMyProfile()).emailChangeAvailable).toBe(false);
    expect(await me.requestEmailChange(NEW)).toEqual({
      ok: false,
      error: "email_transport_unavailable",
    });
  });

  it("la pagina del link: confirmEmailChange(token) dice la nuova email; un token sbagliato o usato è «link»", async () => {
    as(SARA);
    markReauthenticated(SARA);
    await me.requestEmailChange(NEW);
    const token = __secretValuesForTest()
      .find((s) => s.kind === "email_change_link")!
      .values.at(-1)!;
    expect(await me.confirmEmailChange("nope")).toEqual({
      ok: false,
      error: "invalid",
      reason: "link",
    });
    expect(await me.confirmEmailChange(token)).toEqual({ ok: true, email: NEW });
    expect(await me.confirmEmailChange(token)).toEqual({
      ok: false,
      error: "invalid",
      reason: "link",
    });
  });

  it("la lettura del link (getEmailChangeLink) dice la nuova email e NON conferma; un link non valido è «invalid»", async () => {
    as(SARA);
    markReauthenticated(SARA);
    await me.requestEmailChange(NEW);
    const token = __secretValuesForTest()
      .find((s) => s.kind === "email_change_link")!
      .values.at(-1)!;
    expect(await me.getEmailChangeLink(token)).toEqual({ status: "valid", email: NEW });
    expect((await me.getMyProfile()).email).toBe(OLD);
    expect(await me.getEmailChangeLink("nope")).toEqual({ status: "invalid" });
    advanceNow((24 * 60 + 1) * 60_000);
    expect(await me.getEmailChangeLink(token)).toEqual({ status: "invalid" });
  });

  it("l'email non cambia più da updateProfile", async () => {
    as(SARA);
    await me.updateProfile({ email: NEW } as never);
    expect((await me.getMyProfile()).email).toBe(OLD);
  });
});

describe("un admin cambia l'email di un'altra persona", () => {
  it("subito, con la riconferma; annulla la richiesta in attesa; l'avviso nomina l'admin", async () => {
    as(SARA);
    markReauthenticated(SARA);
    await me.requestEmailChange("pending@new.example.com");
    as("p-roberta");
    state.reauth.delete("p-roberta");
    expect(await admin.changeEmail(SARA, NEW)).toEqual({ ok: false, error: "reauth_required" });
    markReauthenticated("p-roberta");
    expect(await admin.changeEmail(SARA, NEW)).toEqual({ ok: true });
    expect(await loginOk(NEW)).toBe(true);
    expect(await loginOk(OLD)).toBe(false);
    as(SARA);
    expect((await me.getMyProfile()).pendingEmail).toBeNull();
    expect(state.securityEvents.find((e) => e.kind === "email_changed")).toMatchObject({
      personId: SARA,
      byId: "p-roberta",
    });
    expect(state.notifications.at(-1)).toMatchObject({
      kind: "security.alert",
      recipientIds: [SARA],
    });
    expect(JSON.stringify(state.notifications.at(-1))).toContain("Roberta");
  });

  it("mai su sé stessi, email_taken, e senza users.manage forbidden", async () => {
    as("p-roberta");
    markReauthenticated("p-roberta");
    expect(await admin.changeEmail("p-roberta", NEW)).toMatchObject({ reason: "self" });
    expect(await admin.changeEmail(SARA, "laura.costa@example.com")).toMatchObject({
      reason: "email_taken",
    });
    as(SARA);
    markReauthenticated(SARA);
    expect(await admin.changeEmail("p-marco", NEW)).toMatchObject({ error: "forbidden" });
  });

  it("mai su una persona disattivata (review F1, M7): l'email resta quella", async () => {
    as("p-roberta");
    markReauthenticated("p-roberta");
    expect(await admin.deactivatePerson(SARA, {})).toMatchObject({ ok: true });
    markReauthenticated("p-roberta");
    expect(await admin.changeEmail(SARA, NEW)).toEqual({
      ok: false,
      error: "invalid",
      reason: "status",
    });
    expect(state.securityEvents.some((e) => e.kind === "email_changed")).toBe(false);
  });
});
