import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  auth,
  changelog,
  createProject,
  createTask,
  listDepartments,
  listProjects,
  me,
  resetApi,
  setLatency,
} from "../api";
import { accessState, isFullAdmin, roleIdOf, seedAccessState } from "../access/index";
import { __secretValuesForTest } from "../admin/secrets";
import { PEOPLE, CLAUDE_ID } from "../seed/people";
import { NO_SESSION_PERSON_ID, getSessionPersonId, setSessionPersonId } from "../session";
import { advanceNow, state } from "../store";
import { can, canInDepartment, viewerFor } from "../viewer";
import { hasFreshReauth, markReauthenticated } from "./reauth";

// L'ingresso nel livello dati (area 9a, Task 5): login col secondo fattore,
// registrazione su invito, primo avvio su un'istanza vuota, uscita.

const as = (personId: string) => setSessionPersonId(personId);
const MINUTE = 60_000;
const ACQ = "prj-acq";

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

const BAD = { ok: false, error: "invalid_credentials" };

describe("login", () => {
  it("password sbagliata, email inesistente e persona disattivata danno lo stesso errore", async () => {
    const before = JSON.stringify([state.entry, state.sessions, state.securityEvents]);
    expect(await auth.login({ email: "laura.costa@example.com", password: "nope" })).toEqual(BAD);
    expect(await auth.login({ email: "nobody@example.com", password: "stubwise" })).toEqual(BAD);
    expect(
      await auth.login({ email: "simone.rossetti@example.com", password: "stubwise" }),
    ).toEqual(BAD);
    expect(await auth.login({ email: "", password: "" })).toEqual(BAD);
    expect(JSON.stringify([state.entry, state.sessions, state.securityEvents])).toBe(before);
  });

  it("Laura: la password apre il secondo passo; il codice la fa entrare e vale come riconferma", async () => {
    await auth.logout();
    expect(await auth.login({ email: "Laura.Costa@example.com ", password: "stubwise" })).toEqual({
      ok: true,
      stage: "second_factor",
    });
    expect(await auth.getEntry()).toEqual({ stage: "second_factor" });
    expect(await auth.loginSecondFactor({ method: "totp", code: "000000" })).toEqual({
      ok: false,
      error: "invalid_code",
      triesLeft: 4,
    });
    expect(await auth.getEntry()).toEqual({ stage: "second_factor" });
    expect(hasFreshReauth("p-laura")).toBe(false);
    expect(await auth.loginSecondFactor({ method: "totp", code: "123456" })).toEqual({
      ok: true,
      stage: "in",
      personId: "p-laura",
    });
    expect(await auth.getEntry()).toEqual({ stage: "in" });
    expect(hasFreshReauth("p-laura")).toBe(true);
    expect(state.securityEvents.at(-1)).toMatchObject({ personId: "p-laura", kind: "signed_in" });
    expect(state.sessions.filter((s) => s.personId === "p-laura" && s.current)).toHaveLength(1);
  });

  it("con una passkey o un codice di backup si entra lo stesso", async () => {
    await auth.login({ email: "roberta.fontana@example.com", password: "stubwise" });
    expect(await auth.loginSecondFactor({ method: "passkey" })).toMatchObject({ stage: "in" });
  });

  it("5 codici sbagliati al login: bloccato, registrato e avvisato (solo lei); le sessioni aperte restano", async () => {
    const sessions = state.sessions.filter((s) => s.personId === "p-laura").length;
    await auth.login({ email: "laura.costa@example.com", password: "stubwise" });
    for (let i = 0; i < 4; i++) await auth.loginSecondFactor({ method: "totp", code: "000000" });
    expect(await auth.loginSecondFactor({ method: "totp", code: "000000" })).toMatchObject({
      ok: false,
      error: "locked",
    });
    expect(await auth.loginSecondFactor({ method: "totp", code: "123456" })).toMatchObject({
      error: "locked",
    });
    expect(state.notifications.at(-1)).toMatchObject({
      kind: "security.alert",
      recipientIds: ["p-laura"],
    });
    expect(state.securityEvents.at(-1)).toMatchObject({ kind: "second_factor_locked" });
    expect(state.sessions.filter((s) => s.personId === "p-laura")).toHaveLength(sessions);
    // E la sessione aperta può ancora lavorare (il blocco riguarda i login nuovi).
    as("p-laura");
    expect(await me.renamePasskey("pk-p-laura-1", "Still mine")).toEqual({ ok: true });
  });

  it("il secondo passo senza un login a metà, o dopo 10 minuti, chiede di ricominciare", async () => {
    expect(await auth.loginSecondFactor({ method: "totp", code: "123456" })).toEqual({
      ok: false,
      error: "login_expired",
    });
    await auth.login({ email: "laura.costa@example.com", password: "stubwise" });
    advanceNow(10 * MINUTE + 1000);
    expect(await auth.loginSecondFactor({ method: "totp", code: "123456" })).toEqual({
      ok: false,
      error: "login_expired",
    });
    expect(hasFreshReauth("p-laura")).toBe(false);
  });

  it("Sara entra senza secondo passo; la sua prima azione +R chiede l'iscrizione", async () => {
    await auth.logout();
    expect(await auth.login({ email: "sara.montanari@example.com", password: "stubwise" })).toEqual(
      {
        ok: true,
        stage: "in",
        personId: "p-sara",
      },
    );
    as("p-sara");
    expect(hasFreshReauth("p-sara")).toBe(false);
    const create = () => me.createToken({ name: "laptop", expiresAt: null });
    expect(await create()).toEqual({ ok: false, error: "reauth_required" });
    // Il dialogo della riconferma: niente da verificare, quindi l'iscrizione.
    expect(await auth.reauthenticate({ method: "totp", code: "123456" })).toEqual({
      ok: false,
      error: "no_second_factor",
    });
    await auth.enrollDuringReauth();
    expect(await me.confirmTotp("123456")).toMatchObject({ ok: true });
    // A fine iscrizione la sessione conta come riconfermata: l'azione passa.
    expect(await create()).toMatchObject({ ok: true });
  });

  it("disattivata: esce (sessioni chiuse), non entra, non ha permessi, nemmeno di reparto; riattivata torna com'era", async () => {
    expect(canInDepartment(viewerFor("p-laura"), "department.home.manage", "dep-development")).toBe(
      true,
    );
    as("p-roberta");
    markReauthenticated("p-roberta");
    expect(await admin.deactivatePerson("p-laura", {})).toMatchObject({ ok: true });
    expect(state.sessions.filter((s) => s.personId === "p-laura")).toEqual([]);
    expect(await auth.login({ email: "laura.costa@example.com", password: "stubwise" })).toEqual(
      BAD,
    );
    expect(can(viewerFor("p-laura"), "tickets.view_all", ACQ)).toBe(false);
    expect(canInDepartment(viewerFor("p-laura"), "department.home.manage", "dep-development")).toBe(
      false,
    );
    expect(await admin.reactivatePerson("p-laura")).toMatchObject({ ok: true });
    expect(can(viewerFor("p-laura"), "tickets.view_all", ACQ)).toBe(true);
    expect(canInDepartment(viewerFor("p-laura"), "department.home.manage", "dep-development")).toBe(
      true,
    );
    expect((await auth.login({ email: "laura.costa@example.com", password: "stubwise" })).ok).toBe(
      true,
    );
  });

  it("logout: si esce, la sessione di questa app si chiude", async () => {
    as("p-giulia");
    expect(await auth.logout()).toEqual({ ok: true });
    expect(await auth.getEntry()).toEqual({ stage: "out" });
    expect(state.sessions.filter((s) => s.personId === "p-giulia").map((s) => s.current)).toEqual([
      false,
      false,
    ]);
  });
});

describe("registrazione su invito", () => {
  async function invite(projects = [{ projectId: ACQ, roleId: roleIdOf("developer") }]) {
    as("p-roberta");
    markReauthenticated("p-roberta");
    const r = await admin.createInvite({
      email: "nora.nuova@example.com",
      instanceRoleId: roleIdOf("user"),
      projects,
    });
    expect(r.ok).toBe(true);
    return (r as { link: string }).link;
  }
  const tokenOf = (link: string) => link.split("invite=")[1]!;

  it("un invito valido dice chi invita e i progetti, e crea la persona con i suoi ruoli", async () => {
    const link = await invite();
    expect(await auth.getInvite(tokenOf(link))).toEqual({
      status: "valid",
      email: "nora.nuova@example.com",
      invitedByName: "Roberta Fontana",
      projects: [{ projectId: ACQ, code: "ACQ", name: expect.any(String), roleName: "Developer" }],
      instanceRoleName: null,
      expiresAt: expect.any(String),
    });
    // Anche il link intero.
    expect(await auth.getInvite(link)).toMatchObject({ status: "valid" });
    // Chi si registra è fuori (la pagina dell'invito è fuori dall'app).
    await auth.logout();
    const entry = JSON.stringify(state.entry);
    expect(await auth.getEntry()).toEqual({ stage: "out" });
    const sessions = state.sessions.length;
    const result = await auth.register(tokenOf(link), {
      name: "Nora Nuova",
      password: "a-long-one",
    });
    expect(result).toMatchObject({ ok: true, personId: expect.any(String) });
    const personId = (result as { personId: string }).personId;
    expect(PEOPLE.find((p) => p.id === personId)).toMatchObject({
      name: "Nora Nuova",
      initials: "NN",
    });
    expect(accessState().people.find((p) => p.personId === personId)).toEqual({
      personId,
      instanceRoleId: roleIdOf("user"),
      status: "active",
      deactivatedAt: null,
      secondFactor: null,
    });
    expect(accessState().memberships).toContainEqual({
      personId,
      projectId: ACQ,
      roleId: roleIdOf("developer"),
    });
    expect(state.projectsById.get(ACQ)!.memberIds).toContain(personId);
    expect(can(viewerFor(personId), "runs.start", ACQ)).toBe(true);
    // Non apre una sessione (`second-factor.md`): si entra dal login.
    expect(JSON.stringify(state.entry)).toBe(entry);
    expect(state.sessions).toHaveLength(sessions);
    expect(await auth.login({ email: "nora.nuova@example.com", password: "a-long-one" })).toEqual({
      ok: true,
      stage: "in",
      personId,
    });
    // L'invito è usato: il link non vale più per registrarsi, ma chi lo
    // riapre legge «già usato» (senza nomi), non «link sconosciuto». Il
    // segreto resta custodito per questo, come per un invito revocato.
    expect(await auth.getInvite(link)).toEqual({ status: "used" });
    expect(await auth.getInvite(tokenOf(link))).toEqual({ status: "used" });
    expect(await auth.register(link, { name: "Again", password: "a-long-one" })).toEqual({
      ok: false,
      error: "used",
    });
    expect(PEOPLE.filter((p) => p.name === "Again")).toHaveLength(0);
    // Un link inventato resta «invalid».
    expect(await auth.getInvite("made-up")).toEqual({ status: "invalid" });
    // Nel registro: chi ha accettato, mai il link.
    as("p-roberta");
    const entries = await changelog.listChanges();
    expect(entries[0]).toMatchObject({ kind: "invite.accepted", actorName: "Nora Nuova" });
    expect(JSON.stringify(entries)).not.toContain(tokenOf(link));
  });

  it("uno scaduto non registra e lo dice", async () => {
    const link = await invite();
    advanceNow(8 * 24 * 60 * MINUTE);
    expect(await auth.getInvite(link)).toEqual({
      status: "expired",
      invitedByName: "Roberta Fontana",
      invitedAt: state.invites.at(-1)!.createdAt,
      expiresAt: state.invites.at(-1)!.expiresAt,
    });
    const people = PEOPLE.length;
    const access = JSON.stringify(accessState());
    expect(await auth.register(link, { name: "Nora", password: "a-long-one" })).toEqual({
      ok: false,
      error: "expired",
    });
    expect(PEOPLE).toHaveLength(people);
    expect(JSON.stringify(accessState())).toBe(access);
  });

  it("uno revocato non registra e lo dice; un link inventato è «invalid»", async () => {
    const link = await invite();
    const id = state.invites.at(-1)!.id;
    expect(await admin.revokeInvite(id)).toEqual({ ok: true });
    expect(await auth.getInvite(link)).toEqual({
      status: "revoked",
      invitedByName: "Roberta Fontana",
    });
    expect(await auth.register(link, { name: "Nora", password: "a-long-one" })).toEqual({
      ok: false,
      error: "revoked",
    });
    expect(await auth.getInvite("made-up")).toEqual({ status: "invalid" });
  });

  it("nome vuoto o password corta: rifiutata, l'invito resta valido", async () => {
    const link = await invite();
    expect(await auth.register(link, { name: " ", password: "a-long-one" })).toMatchObject({
      error: "invalid_input",
      reason: "name",
    });
    expect(await auth.register(link, { name: "Nora", password: "short" })).toMatchObject({
      reason: "password",
    });
    expect(await auth.getInvite(link)).toMatchObject({ status: "valid" });
  });
});

describe("ingresso: le aggiunte del Task 6", () => {
  it("readEntry: lo stato dell'ingresso subito, senza latenza, con l'istanza vuota", async () => {
    expect(auth.readEntry()).toEqual({ stage: "in", empty: false });
    await auth.logout();
    expect(auth.readEntry()).toEqual({ stage: "out", empty: false });
    await auth.login({ email: "laura.costa@example.com", password: "stubwise" });
    expect(auth.readEntry()).toEqual({ stage: "second_factor", empty: false });
    await auth.resetToEmptyInstance();
    expect(auth.readEntry()).toEqual({ stage: "out", empty: true });
  });

  it("un invito che dà un ruolo d'istanza diverso da User lo dice", async () => {
    as("p-roberta");
    markReauthenticated("p-roberta");
    const r = await admin.createInvite({
      email: "aldo.auditor@example.com",
      instanceRoleId: roleIdOf("au-1"),
      projects: [],
    });
    const link = (r as { link: string }).link;
    expect(await auth.getInvite(link)).toMatchObject({
      status: "valid",
      instanceRoleName: "Auditor",
    });
  });

  it("una passkey fallita conta come un codice sbagliato", async () => {
    await auth.logout();
    await auth.login({ email: "laura.costa@example.com", password: "stubwise" });
    expect(await auth.loginSecondFactor({ method: "passkey", simulate: "fail" })).toEqual({
      ok: false,
      error: "invalid_code",
      triesLeft: 4,
    });
    expect(state.secondFactorAttempts.get("p-laura")?.failures).toBe(1);
  });

  it("simulateInviteLink: un link nuovo per l'invito del seme in sospeso o scaduto, una volta", async () => {
    const pending = await auth.simulateInviteLink("pending");
    expect(pending).toEqual({ token: expect.any(String) });
    expect(await auth.getInvite(pending!.token)).toMatchObject({
      status: "valid",
      email: "ines.ricci@example.com",
    });
    const expired = await auth.simulateInviteLink("expired");
    expect(await auth.getInvite(expired!.token)).toMatchObject({
      status: "expired",
      invitedByName: "Roberta Fontana",
    });
    // Un secondo link per lo stesso invito sostituisce il primo.
    const again = await auth.simulateInviteLink("pending");
    expect(await auth.getInvite(pending!.token)).toEqual({ status: "invalid" });
    expect(await auth.getInvite(again!.token)).toMatchObject({ status: "valid" });
    // Nessun invito adatto (istanza vuota): `null`.
    await auth.resetToEmptyInstance();
    expect(await auth.simulateInviteLink("pending")).toBeNull();
  });

  it("passMinutes: l'orologio va avanti e il blocco scade", async () => {
    await auth.logout();
    await auth.login({ email: "laura.costa@example.com", password: "stubwise" });
    for (let i = 0; i < 5; i++) await auth.loginSecondFactor({ method: "totp", code: "000000" });
    expect(await auth.loginSecondFactor({ method: "totp", code: "123456" })).toMatchObject({
      error: "locked",
    });
    await auth.passMinutes(15);
    await auth.login({ email: "laura.costa@example.com", password: "stubwise" });
    expect(await auth.loginSecondFactor({ method: "totp", code: "123456" })).toMatchObject({
      ok: true,
    });
  });

  it("prototypeAccounts: nome ed email delle persone attive chieste, mai le disattivate", async () => {
    expect(await auth.prototypeAccounts(["p-laura", "p-simone", "p-nope"])).toEqual([
      { personId: "p-laura", name: "Laura Costa", email: "laura.costa@example.com" },
    ]);
  });
});

describe("istanza vuota e primo avvio", () => {
  it("dopo resetToEmptyInstance restano solo Claude e le tabelle vuote; si è fuori", async () => {
    expect(await auth.isInstanceEmpty()).toBe(false);
    expect(await auth.resetToEmptyInstance()).toEqual({ ok: true });
    expect(await auth.isInstanceEmpty()).toBe(true);
    expect(PEOPLE.map((p) => p.id)).toEqual([CLAUDE_ID]);
    expect(await auth.getEntry()).toEqual({ stage: "out" });
    // La sessione non resta su una persona che non esiste più: «nessuno».
    expect(getSessionPersonId()).toBe(NO_SESSION_PERSON_ID);
    expect(await me.listTokens()).toEqual([]);
    const s = state as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(s)) {
      if (Array.isArray(value)) expect(value, key).toEqual([]);
      if (value instanceof Map || value instanceof Set) expect(value.size, key).toBe(0);
    }
    const access = accessState();
    expect(access.people).toEqual([]);
    expect(access.memberships).toEqual([]);
    expect(access.grants).toEqual([]);
    expect(access.departments).toEqual([]);
    expect(access.roles.every((r) => r.preset)).toBe(true);
    expect(__secretValuesForTest()).toEqual([]);
    // Claude resta, coi suoi permessi fissi (R-L9); nessun progetto da vedere.
    expect(can(viewerFor(CLAUDE_ID), "monitor.view")).toBe(true);
    as(CLAUDE_ID);
    expect(await listProjects()).toEqual([]);
  });

  it("il primo avvio crea un full admin, una volta sola; poi si entra dal login", async () => {
    await auth.resetToEmptyInstance();
    expect(
      await auth.createFirstAdmin({ name: "Ada", email: "ada@example", password: "a-long-one" }),
    ).toMatchObject({ error: "invalid_input", reason: "email" });
    expect(await auth.isInstanceEmpty()).toBe(true);
    const result = await auth.createFirstAdmin({
      name: "Ada Lovelace",
      email: "Ada@Example.com",
      password: "a-long-one",
    });
    expect(result).toMatchObject({ ok: true });
    const personId = (result as { personId: string }).personId;
    expect(isFullAdmin(personId)).toBe(true);
    expect(await auth.isInstanceEmpty()).toBe(false);
    expect(await auth.getEntry()).toEqual({ stage: "out" });
    expect(
      await auth.createFirstAdmin({
        name: "Eve",
        email: "eve@example.com",
        password: "a-long-one",
      }),
    ).toEqual({ ok: false, error: "not_empty" });
    expect(await auth.login({ email: "ada@example.com", password: "a-long-one" })).toEqual({
      ok: true,
      stage: "in",
      personId,
    });
    as(personId);
    expect(await listProjects()).toEqual([]);
  });

  it("I1: istanza vuota, primo admin, nuovo progetto, nuova task — la task ha il reparto General", async () => {
    await auth.resetToEmptyInstance();
    const result = await auth.createFirstAdmin({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "a-long-one",
    });
    const personId = (result as { personId: string }).personId;
    as(personId);
    const departments = await listDepartments();
    expect(departments.map((d) => d.name)).toEqual(["General"]);
    expect(PEOPLE.find((p) => p.id === personId)!.departmentIds).toEqual([departments[0]!.id]);
    const project = await createProject({ code: "ADA", name: "First", template: "empty" });
    const task = await createTask({ projectId: project.id, title: "Hello" });
    expect(task.departmentId).toBe(departments[0]!.id);
    // Il reparto nato col primo avvio è nel registro come gli altri.
    expect(state.changelog.map((e) => e.kind)).toContain("department.created");
  });

  it("resetApi torna al seme", async () => {
    // Le persone del seme da una fonte che non dipende da `PEOPLE` di adesso
    // (un test precedente che l'avesse lasciata sporca non deve bastare).
    const seedIds = [...seedAccessState().people.map((p) => p.personId), CLAUDE_ID];
    await auth.resetToEmptyInstance();
    await auth.createFirstAdmin({ name: "Ada", email: "ada@example.com", password: "a-long-one" });
    resetApi();
    expect(PEOPLE.map((p) => p.id)).toEqual(seedIds);
    expect(accessState()).toEqual(seedAccessState());
    expect(await auth.getEntry()).toEqual({ stage: "in" });
    as("p-giulia");
    expect((await listProjects()).length).toBeGreaterThan(0);
    expect(state.tasks.length).toBeGreaterThan(0);
  });
});
