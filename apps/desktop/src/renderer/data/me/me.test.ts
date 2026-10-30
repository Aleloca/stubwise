import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  admin,
  auth,
  calendar,
  changelog,
  drive,
  listNotifications,
  mail,
  me,
  resetApi,
  setLatency,
} from "../api";
import { accessState, writeAccess } from "../access/index";
import { __secretValuesForTest, secretIdsOf } from "../admin/secrets";
import { REAUTH_REQUIRED, hasFreshReauth, markReauthenticated } from "../auth/reauth";
import { PEOPLE } from "../seed/people";
import { getSessionCredential, getSessionPersonId, setSessionPersonId } from "../session";
import { advanceNow, state, type ApiFnName } from "../store";
import { VIEW_AS_PERSONAS } from "../viewer";
import { callWithToken } from "./tokens";

// Le Preferenze personali nel livello dati (area 9a, Task 5): Account, le
// caselle Google, Sicurezza, Token, il comando di Claude Code. Ogni rifiuto
// si controlla insieme allo stato invariato.

const as = (personId: string) => setSessionPersonId(personId);
const reauth = (personId: string) => markReauthenticated(personId);
const MINUTE = 60_000;

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

/** Ciò che una scrittura delle Preferenze può toccare: deve restare uguale dopo un rifiuto. */
const snapshot = () =>
  JSON.stringify([
    state.tokens,
    state.passkeys,
    state.sessions,
    state.securityEvents,
    state.notifications,
    state.confirmedTotp,
    [...state.confirmedTotp],
    accessState(),
    __secretValuesForTest(),
  ]);

const value = <T extends object>(r: { ok: boolean } & object): T => {
  expect(r.ok).toBe(true);
  return r as unknown as T;
};

// --- la riconferma ---------------------------------------------------------------

/** Ogni funzione +R del Task 5, chiamata come la chiamerebbe la sua pagina. */
const SENSITIVE: [ApiFnName, () => Promise<{ ok: boolean }>][] = [
  ["me.startTotpSetup", () => me.startTotpSetup()],
  ["me.addPasskey", () => me.addPasskey("Work laptop")],
  ["me.removePasskey", () => me.removePasskey("pk-p-laura-1")],
  ["me.regenerateBackupCodes", () => me.regenerateBackupCodes()],
  ["me.createToken", () => me.createToken({ name: "laptop", expiresAt: null })],
  ["me.createClaudeCodeCommand", () => me.createClaudeCodeCommand()],
];

describe("riconferma", () => {
  it("le funzioni +R del Task 5 sono tutte dichiarate", () => {
    for (const [name] of SENSITIVE) expect(REAUTH_REQUIRED.has(name), name).toBe(true);
  });

  it.each(SENSITIVE)(
    "%s senza riconferma → reauth_required, stato e registro invariati",
    async (_, call) => {
      as("p-laura");
      const before = snapshot();
      expect(await call()).toEqual({ ok: false, error: "reauth_required" });
      expect(snapshot()).toBe(before);
    },
  );

  it.each(SENSITIVE)("%s dopo 10:01 minuti dalla riconferma → reauth_required", async (_, call) => {
    as("p-laura");
    reauth("p-laura");
    advanceNow(10 * MINUTE + 1000);
    const before = snapshot();
    expect(await call()).toEqual({ ok: false, error: "reauth_required" });
    expect(snapshot()).toBe(before);
  });

  it.each(SENSITIVE)("%s con la riconferma passa", async (_, call) => {
    as("p-laura");
    reauth("p-laura");
    expect((await call()).ok).toBe(true);
  });

  it("le azioni non delicate non la chiedono: rinominare una passkey, chiudere una sessione, revocare un token", async () => {
    as("p-laura");
    expect(await me.renamePasskey("pk-p-laura-1", "Work Mac")).toEqual({ ok: true });
    expect(await me.endSession("ses-p-laura-1")).toEqual({ ok: true });
    expect(await me.revokeToken("pat-laura-1")).toEqual({ ok: true });
  });
});

describe("un PAT non soddisfa mai la riconferma", () => {
  async function marcosToken(): Promise<string> {
    as("p-marco");
    reauth("p-marco");
    return value<{ token: string }>(await me.createToken({ name: "laptop", expiresAt: null }))
      .token;
  }

  it("una chiamata via token resta reauth_required anche dentro la finestra di grazia del titolare", async () => {
    const token = await marcosToken();
    expect(hasFreshReauth("p-marco")).toBe(true);
    const before = snapshot();
    expect(
      await callWithToken(token, () => me.createToken({ name: "from a tool", expiresAt: null })),
    ).toEqual({ ok: false, error: "reauth_required" });
    expect(await callWithToken(token, () => me.createClaudeCodeCommand())).toEqual({
      ok: false,
      error: "reauth_required",
    });
    // Il token ha un ultimo uso; nient'altro è cambiato.
    const row = state.tokens.find((t) => t.name === "laptop")!;
    expect(row.lastUsedAt).not.toBeNull();
    row.lastUsedAt = null;
    expect(snapshot()).toBe(before);
    // La stessa richiesta dalla sessione di Marco, nella stessa finestra, passa.
    expect((await me.createToken({ name: "from the app", expiresAt: null })).ok).toBe(true);
  });

  it("un token di chi può invitare non conia inviti: reauth_required dentro la finestra, niente cambia", async () => {
    as("p-roberta");
    markReauthenticated("p-roberta");
    const token = value<{ token: string }>(
      await me.createToken({ name: "roberta-cli", expiresAt: null }),
    ).token;
    const input = { email: "x@example.com", instanceRoleId: "role-user", projects: [] };
    const invites = JSON.stringify(state.invites);
    expect(await callWithToken(token, () => admin.createInvite(input))).toEqual({
      ok: false,
      error: "reauth_required",
    });
    expect(JSON.stringify(state.invites)).toBe(invites);
    // Dalla sessione di Roberta, nella stessa finestra, passa.
    expect((await admin.createInvite(input)).ok).toBe(true);
  });

  it("via token la chiamata è del titolare e marcata pat; dopo si torna alla sessione di prima", async () => {
    const token = await marcosToken();
    as("p-giulia");
    let seen: [string, string] | null = null;
    await callWithToken(token, async () => {
      seen = [getSessionPersonId(), getSessionCredential()];
      return me.listTokens();
    });
    expect(seen).toEqual(["p-marco", "pat"]);
    expect([getSessionPersonId(), getSessionCredential()]).toEqual(["p-giulia", "session"]);
  });

  it("un token revocato, scaduto, inventato o di una persona disattivata non chiama niente", async () => {
    const token = await marcosToken();
    const expiring = value<{ token: string }>(
      await me.createToken({ name: "short", expiresAt: "2026-10-24T00:00:00Z" }),
    ).token;
    const call = (t: string) =>
      callWithToken(t, () => me.listTokens()).then(
        () => "ok",
        (e: Error) => e.message,
      );
    expect(await call(token)).toBe("ok");
    expect(await call("stw_pat_madeup")).toBe("unauthorized");
    advanceNow(24 * 60 * MINUTE);
    expect(await call(expiring)).toBe("unauthorized");
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-marco")!.status = "deactivated";
    });
    expect(await call(token)).toBe("unauthorized");
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-marco")!.status = "active";
    });
    as("p-marco");
    const id = state.tokens.find((t) => t.name === "laptop")!.id;
    expect(await me.revokeToken(id)).toEqual({ ok: true });
    expect(await call(token)).toBe("unauthorized");
  });
});

// --- RF 2: i segreti si vedono una volta ---------------------------------------------

describe("RF 2: token, comando, chiave TOTP e codici di backup non ricompaiono", () => {
  /** Una lettura, o il suo rifiuto (chi non gestisce le persone non legge il registro altrui). */
  const read = (p: Promise<unknown>) => p.catch((e: Error) => e.message);
  async function everyRead(): Promise<string> {
    return JSON.stringify([
      await me.listTokens(),
      await me.getMySecurity(),
      await me.listMyMailboxes(),
      await admin.listPeople(),
      await read(admin.getPerson("p-laura")),
      await read(admin.listSecurityEvents("p-laura")),
      await changelog.listChanges(),
      await listNotifications(),
      state.changelog,
      state.notifications,
      state.securityEvents,
      state.tokens,
      state.passkeys,
      state.sessions,
      [...state.confirmedTotp],
      accessState(),
    ]);
  }

  it("dopo ogni creazione nessuna lettura, voce del registro o notifica contiene il valore", async () => {
    as("p-laura");
    reauth("p-laura");
    const token = value<{ token: string }>(
      await me.createToken({ name: "laptop", expiresAt: null }),
    ).token;
    const command = value<{ command: string }>(await me.createClaudeCodeCommand()).command;
    const setup = value<{ setup: { secret: string; uri: string } }>(
      await me.startTotpSetup(),
    ).setup;
    expect(value<{ backupCodes: null }>(await me.confirmTotp("123456")).backupCodes).toBeNull();
    const codes = value<{ codes: string[] }>(await me.regenerateBackupCodes()).codes;
    expect(token).toMatch(/^stw_pat_/);
    expect(command).toContain("--token stw_pat_");
    expect(codes).toHaveLength(10);
    const commandToken = command.match(/stw_pat_\w+/)![0];
    as("p-roberta");
    reauth("p-roberta");
    const roberta = await everyRead();
    as("p-laura");
    const laura = await everyRead();
    for (const secret of [
      token,
      commandToken,
      setup.secret,
      setup.uri,
      ...codes,
      ...__secretValuesForTest().flatMap((s) => s.values),
    ]) {
      expect(laura).not.toContain(secret);
      expect(roberta).not.toContain(secret);
    }
  });

  it("i codici di backup della prima attivazione si vedono una volta", async () => {
    as("p-sara");
    await auth.enrollDuringReauth();
    const codes = value<{ backupCodes: string[] }>(await me.confirmTotp("123456")).backupCodes;
    expect(codes).toHaveLength(10);
    const reads = JSON.stringify([await me.getMySecurity(), state.securityEvents, accessState()]);
    for (const c of codes) expect(reads).not.toContain(c);
  });
});

// --- Account ------------------------------------------------------------------------

describe("Account", () => {
  it("il nome cambia ovunque (persone, «vedi come»), l'email d'accesso no se non la si cambia", async () => {
    as("p-sara");
    expect(await me.updateProfile({ name: "Sara Montanari Rossi" })).toEqual({ ok: true });
    expect(PEOPLE.find((p) => p.id === "p-sara")).toMatchObject({
      name: "Sara Montanari Rossi",
      initials: "SM",
    });
    expect(VIEW_AS_PERSONAS.find((p) => p.personId === "p-sara")!.name).toBe(
      "Sara Montanari Rossi",
    );
    // L'email del seme derivava dal nome: resta quella, e si entra ancora con lei.
    expect(
      await auth.login({ email: "sara.montanari@example.com", password: "stubwise" }),
    ).toMatchObject({
      ok: true,
      stage: "in",
    });
  });

  it("email non valida o già di un altro: rifiutata, niente cambia", async () => {
    as("p-sara");
    const before = JSON.stringify(PEOPLE);
    expect(await me.updateProfile({ email: "not-an-email" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "email",
    });
    expect(await me.updateProfile({ email: "Laura.Costa@example.com", name: "X" })).toEqual({
      ok: false,
      error: "invalid",
      reason: "email_taken",
    });
    expect(await me.updateProfile({ name: "  " })).toMatchObject({ reason: "name" });
    expect(JSON.stringify(PEOPLE)).toBe(before);
  });

  it("l'email nuova diventa quella d'accesso; la foto si mette e si toglie", async () => {
    as("p-sara");
    expect(
      await me.updateProfile({ email: "sara@example.com", avatar: "data:image/png;base64,AAA" }),
    ).toEqual({ ok: true });
    expect(PEOPLE.find((p) => p.id === "p-sara")!.photo).toBe("data:image/png;base64,AAA");
    expect((await auth.login({ email: "sara@example.com", password: "stubwise" })).ok).toBe(true);
    expect(await auth.login({ email: "sara.montanari@example.com", password: "stubwise" })).toEqual(
      {
        ok: false,
        error: "invalid_credentials",
      },
    );
    expect(await me.updateProfile({ avatar: null })).toEqual({ ok: true });
    expect(PEOPLE.find((p) => p.id === "p-sara")!.photo).toBeUndefined();
  });

  it("cambiare la password chiude le altre sessioni (la lista torna a 1) e vale al login", async () => {
    as("p-giulia");
    expect((await me.getMySecurity()).sessions).toHaveLength(3);
    expect(await me.changePassword({ current: "wrong", next: "a-long-one" })).toMatchObject({
      reason: "wrong_password",
    });
    expect(await me.changePassword({ current: "stubwise", next: "short" })).toMatchObject({
      reason: "too_short",
    });
    expect((await me.getMySecurity()).sessions).toHaveLength(3);
    expect(await me.changePassword({ current: "stubwise", next: "a-long-one" })).toEqual({
      ok: true,
      signedOut: 2,
    });
    const sessions = (await me.getMySecurity()).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.current).toBe(true);
    expect(state.securityEvents.at(-1)).toMatchObject({
      personId: "p-giulia",
      kind: "password_changed",
    });
    expect(await auth.login({ email: "giulia.ferri@example.com", password: "stubwise" })).toEqual({
      ok: false,
      error: "invalid_credentials",
    });
    expect(
      (await auth.login({ email: "giulia.ferri@example.com", password: "a-long-one" })).ok,
    ).toBe(true);
    // Le sessioni di un'altra persona non si toccano.
    expect(state.sessions.filter((s) => s.personId === "p-roberta")).toHaveLength(3);
  });
});

// --- Sicurezza ----------------------------------------------------------------------

describe("Sicurezza", () => {
  it("getMySecurity: acceso con app, passkey e codici; Sara spento", async () => {
    as("p-roberta");
    expect(await me.getMySecurity()).toMatchObject({
      on: true,
      totp: true,
      backupCodesLeft: 10,
      passkeys: [{ name: "MacBook Pro" }, { name: "YubiKey" }],
    });
    as("p-sara");
    expect(await me.getMySecurity()).toMatchObject({
      on: false,
      totp: false,
      totpSince: null,
      passkeys: [],
      backupCodesLeft: 0,
    });
  });

  it("la prima attivazione (Sara): codice sbagliato conta, quello giusto accende e riconferma", async () => {
    as("p-sara");
    expect(await me.confirmTotp("123456")).toMatchObject({
      error: "invalid",
      reason: "no_pending",
    });
    await auth.enrollDuringReauth();
    expect(await me.confirmTotp("000000")).toEqual({
      ok: false,
      error: "invalid_code",
      triesLeft: 4,
    });
    expect(accessState().people.find((p) => p.personId === "p-sara")!.secondFactor).toBeNull();
    const result = await me.confirmTotp("123456");
    expect(result).toMatchObject({ ok: true, backupCodes: expect.any(Array) });
    expect(accessState().people.find((p) => p.personId === "p-sara")!.secondFactor).toEqual({
      totp: true,
      passkeys: 0,
      backupCodesLeft: 10,
    });
    expect(hasFreshReauth("p-sara")).toBe(true);
    expect((await me.getMySecurity()).totpSince).not.toBeNull();
    // Il segreto in attesa è diventato quello confermato: non ce n'è un altro.
    expect(await me.confirmTotp("123456")).toMatchObject({ reason: "no_pending" });
  });

  it("la conferma passa dal tetto dei tentativi: al quinto sbagliato è bloccata, anche col codice giusto", async () => {
    as("p-sara");
    await auth.enrollDuringReauth();
    for (let i = 4; i >= 1; i--)
      expect(await me.confirmTotp("000000")).toMatchObject({ triesLeft: i });
    expect(await me.confirmTotp("000000")).toMatchObject({ error: "locked" });
    expect(await me.confirmTotp("123456")).toMatchObject({ error: "locked" });
    expect(accessState().people.find((p) => p.personId === "p-sara")!.secondFactor).toBeNull();
    expect(state.notifications.at(-1)).toMatchObject({
      kind: "security.alert",
      recipientIds: ["p-sara"],
    });
  });

  it("la riconfigurazione: la chiave nuova sostituisce la vecchia solo alla conferma, senza codici nuovi", async () => {
    as("p-laura");
    reauth("p-laura");
    const first = value<{ setup: { secret: string; qrSvg: string } }>(
      await me.startTotpSetup(),
    ).setup;
    expect(first.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(first.qrSvg).toMatch(/^<svg/);
    expect(first.qrSvg).not.toContain(first.secret);
    // Rifarla prima di confermare dimentica la prima chiave in attesa.
    const second = value<{ setup: { secret: string } }>(await me.startTotpSetup()).setup;
    expect(secretIdsOf("totp_seed", "p-laura")).toHaveLength(1);
    expect(await me.confirmTotp("123456")).toEqual({ ok: true, backupCodes: null });
    expect(state.securityEvents.at(-1)).toMatchObject({ kind: "authenticator_changed" });
    // Ancora una: la confermata resta finché la nuova non è confermata, poi sparisce.
    value(await me.startTotpSetup());
    expect(secretIdsOf("totp_seed", "p-laura")).toHaveLength(2);
    await me.confirmTotp("123456");
    expect(secretIdsOf("totp_seed", "p-laura")).toHaveLength(1);
    expect(second.secret).not.toBe(first.secret);
  });

  it("passkey: aggiungi (con avviso), fallita, rinomina, rimuovi; il conteggio segue", async () => {
    as("p-laura");
    reauth("p-laura");
    const count = () =>
      accessState().people.find((p) => p.personId === "p-laura")!.secondFactor!.passkeys;
    const before = snapshot();
    expect(await me.addPasskey("YubiKey", "fail")).toEqual({
      ok: false,
      error: "invalid",
      reason: "passkey_failed",
    });
    expect(await me.addPasskey("   ")).toMatchObject({ reason: "name" });
    expect(snapshot()).toBe(before);
    const added = value<{ passkeyId: string }>(await me.addPasskey("YubiKey"));
    expect(count()).toBe(2);
    expect(state.notifications.at(-1)).toMatchObject({
      kind: "security.alert",
      recipientIds: ["p-laura"],
    });
    expect(await me.renamePasskey(added.passkeyId, "Blue key")).toEqual({ ok: true });
    expect((await me.getMySecurity()).passkeys.map((k) => k.name)).toEqual([
      "MacBook Pro",
      "Blue key",
    ]);
    expect(await me.removePasskey(added.passkeyId)).toEqual({ ok: true });
    expect(count()).toBe(1);
    // La passkey di un altro non esiste per me.
    expect(await me.renamePasskey("pk-p-marco-1", "Mine")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await me.removePasskey("pk-p-marco-1")).toEqual({ ok: false, error: "not_found" });
  });

  it("l'ultimo metodo non si toglie: senza app, l'ultima passkey resta", async () => {
    as("p-laura");
    reauth("p-laura");
    writeAccess((s) => {
      s.people.find((p) => p.personId === "p-laura")!.secondFactor!.totp = false;
    });
    expect(await me.removePasskey("pk-p-laura-1")).toEqual({
      ok: false,
      error: "invalid",
      reason: "last_method",
    });
  });

  it("rigenerare i codici: i vecchi smettono di valere, 10 nuovi una volta, avviso", async () => {
    as("p-laura");
    const old = __secretValuesForTest().find(
      (s) => s.id === secretIdsOf("backup_codes", "p-laura")[0],
    )!.values[1]!;
    reauth("p-laura");
    const codes = value<{ codes: string[] }>(await me.regenerateBackupCodes()).codes;
    expect(codes).toHaveLength(10);
    expect(state.notifications.at(-1)).toMatchObject({
      kind: "security.alert",
      recipientIds: ["p-laura"],
    });
    expect(await auth.reauthenticate({ method: "backup_code", code: old })).toMatchObject({
      error: "invalid_code",
    });
    expect(await auth.reauthenticate({ method: "backup_code", code: codes[0]! })).toEqual({
      ok: true,
    });
    expect((await me.getMySecurity()).backupCodesLeft).toBe(9);
  });

  it("chi non ha un secondo fattore non aggiunge passkey né rigenera codici", async () => {
    as("p-sara");
    expect(await me.addPasskey("Mac")).toMatchObject({ reason: "no_second_factor" });
    expect(await me.regenerateBackupCodes()).toMatchObject({ reason: "no_second_factor" });
  });

  it("sessioni: si chiude un'altra mia, non questa, non quella di un altro", async () => {
    as("p-giulia");
    expect(await me.endSession("ses-p-giulia-app")).toMatchObject({ reason: "current" });
    expect(await me.endSession("ses-p-roberta-1")).toEqual({ ok: false, error: "not_found" });
    expect(await me.endSession("ses-p-giulia-1")).toEqual({ ok: true });
    expect((await me.getMySecurity()).sessions.map((s) => s.id)).toEqual([
      "ses-p-giulia-app",
      "ses-p-giulia-2",
    ]);
  });

  it("il registro personale: solo il mio, più recente prima, con chi l'ha fatto", async () => {
    as("p-roberta");
    reauth("p-roberta");
    await admin.resetSecondFactor("p-marco");
    as("p-marco");
    const events = (await me.getMySecurity()).events;
    expect(events[0]).toMatchObject({ kind: "second_factor_reset", byName: "Roberta Fontana" });
    expect(
      events.every((e) => state.securityEvents.find((x) => x.id === e.id)!.personId === "p-marco"),
    ).toBe(true);
    // Anche le passkey e la chiave di Marco se ne vanno col reset.
    expect((await me.getMySecurity()).passkeys).toEqual([]);
  });
});

// --- Token e Claude Code ---------------------------------------------------------------

describe("Token", () => {
  it("l'elenco ha nome, date e ultimo uso, mai il valore; uno scaduto lo dice", async () => {
    as("p-laura");
    expect(await me.listTokens()).toEqual([
      {
        id: "pat-laura-1",
        name: "ci-release-notes",
        createdAt: expect.any(String),
        expiresAt: expect.any(String),
        expired: true,
        lastUsedAt: expect.any(String),
      },
    ]);
    as("p-sara");
    expect(await me.listTokens()).toEqual([]);
  });

  it("creare: nome e scadenza nel futuro; il token esce una volta e si usa", async () => {
    as("p-sara");
    reauth("p-sara");
    expect(await me.createToken({ name: " ", expiresAt: null })).toMatchObject({ reason: "name" });
    expect(await me.createToken({ name: "x", expiresAt: "2026-10-01" })).toMatchObject({
      reason: "expires_past",
    });
    expect(await me.createToken({ name: "x", expiresAt: "soon" })).toMatchObject({
      reason: "expires",
    });
    const created = value<{ tokenId: string; token: string }>(
      await me.createToken({ name: "my-laptop MCP", expiresAt: "2026-12-31" }),
    );
    expect(created.token).toMatch(/^stw_pat_[a-z2-9]{32}$/);
    expect(await me.listTokens()).toEqual([
      expect.objectContaining({
        id: created.tokenId,
        name: "my-laptop MCP",
        expired: false,
        lastUsedAt: null,
      }),
    ]);
    expect(state.securityEvents.at(-1)).toMatchObject({
      personId: "p-sara",
      kind: "token_created",
    });
  });

  it("revocare: solo i miei; il segreto si dimentica", async () => {
    as("p-sara");
    reauth("p-sara");
    const created = value<{ tokenId: string }>(
      await me.createToken({ name: "t", expiresAt: null }),
    );
    expect(secretIdsOf("pat", "p-sara")).toHaveLength(1);
    as("p-marco");
    expect(await me.revokeToken(created.tokenId)).toEqual({ ok: false, error: "not_found" });
    as("p-sara");
    expect(await me.revokeToken(created.tokenId)).toEqual({ ok: true });
    expect(secretIdsOf("pat", "p-sara")).toEqual([]);
    expect(await me.listTokens()).toEqual([]);
  });
});

describe("Claude Code", () => {
  it("il comando ha la forma del web, con l'istanza e un token nuovo che compare fra i token", async () => {
    as("p-marco");
    reauth("p-marco");
    const result = value<{ command: string; tokenId: string; tokenName: string }>(
      await me.createClaudeCodeCommand(),
    );
    expect(result.command).toMatch(
      /^claude plugin marketplace add Aleloca\/stubwise --sparse \.claude-plugin plugins && claude plugin install stubwise@stubwise && npx -y @stubwise\/mcp@latest setup --url https:\/\/stubwise\.example\.test --token stw_pat_[a-z2-9]{32}$/,
    );
    expect(result.tokenName).toBe("Claude Code · Oct 23");
    const tokens = await me.listTokens();
    expect(tokens.map((t) => t.name)).toContain("Claude Code · Oct 23");
    // Rifarlo crea un altro token; quello di prima resta.
    const again = value<{ tokenId: string }>(await me.createClaudeCodeCommand());
    expect(again.tokenId).not.toBe(result.tokenId);
    expect((await me.listTokens()).filter((t) => t.name === "Claude Code · Oct 23")).toHaveLength(
      2,
    );
  });
});

// --- Le caselle Google ---------------------------------------------------------------

describe("Caselle Google: lo stesso stato di Posta e Calendario", () => {
  it("scollegare una casella cambia ciò che legge la pagina Mail", async () => {
    as("p-giulia");
    expect(await mail.listMailboxes()).toHaveLength(1);
    const { mailboxes } = await me.listMyMailboxes();
    expect(mailboxes).toEqual([
      expect.objectContaining({
        id: "giulia.ferri@example.com",
        status: "connected",
        workspaceName: "Example",
        proposalsEnabled: true,
      }),
    ]);
    expect(await me.disconnectMailbox(mailboxes[0]!.id)).toEqual({ ok: true });
    expect(await mail.listMailboxes()).toEqual([]);
    expect(await calendar.listCalendars()).toEqual([]);
    expect(await drive.getGoogleAccount()).toBeNull();
    expect((await me.listMyMailboxes()).mailboxes).toEqual([]);
  });

  it("l'interruttore «Proposals» è quello della Posta", async () => {
    as("p-giulia");
    expect(await me.setProposals("giulia.ferri@example.com", false)).toEqual({ ok: true });
    expect((await mail.listMailboxes())[0]!.proposalsEnabled).toBe(false);
    await mail.setProposalsEnabled("giulia.ferri@example.com", true);
    expect((await me.listMyMailboxes()).mailboxes[0]!.proposalsEnabled).toBe(true);
    expect(await me.setProposals("matteo.conti@example.com", false)).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("Laura: «needs reconnecting» qui e «expired» nella Posta; Reconnect sistema entrambi", async () => {
    as("p-laura");
    expect((await me.listMyMailboxes()).mailboxes[0]).toMatchObject({
      status: "needs_reconnect",
      sync: "failed",
    });
    expect((await mail.listMailboxes())[0]!.expired).toBe(true);
    expect(await me.reconnectMailbox("laura.costa@example.com", "failed")).toMatchObject({
      reason: "failed",
    });
    expect((await mail.listMailboxes())[0]!.expired).toBe(true);
    expect(await me.reconnectMailbox("laura.costa@example.com")).toEqual({ ok: true });
    expect((await mail.listMailboxes())[0]!.expired).toBe(false);
    expect((await me.listMyMailboxes()).mailboxes[0]).toMatchObject({
      status: "connected",
      sync: "ok",
    });
    expect((await calendar.listCalendars())[0]!.expired).toBe(false);
  });

  it("collegare: un esito negativo non cambia niente; quello positivo crea la casella per tutti", async () => {
    as("p-marco");
    const before = JSON.stringify([state.mailboxes, state.googleAccounts]);
    for (const outcome of ["wrong_domain", "scopes_missing", "owned_by_other", "failed"] as const)
      expect(await me.connectMailbox("gw-example", outcome)).toEqual({
        ok: false,
        error: "invalid",
        reason: outcome,
      });
    expect(await me.connectMailbox("gw-missing")).toEqual({ ok: false, error: "not_found" });
    expect(JSON.stringify([state.mailboxes, state.googleAccounts])).toBe(before);
    const connected = await me.connectMailbox("gw-example");
    expect(connected).toMatchObject({
      ok: true,
      mailbox: { email: "marco.bellini@example.com", status: "connected", proposalsEnabled: true },
    });
    expect(await mail.listMailboxes()).toHaveLength(1);
    expect(await drive.getGoogleAccount()).toMatchObject({ status: "connected" });
    expect(await me.connectMailbox("gw-example")).toMatchObject({ reason: "already_connected" });
  });

  it("scollegare e ricollegare rimette «Proposals» com'era (Laura le aveva spente)", async () => {
    as("p-laura");
    expect((await me.listMyMailboxes()).mailboxes[0]!.proposalsEnabled).toBe(false);
    expect(await me.disconnectMailbox("laura.costa@example.com")).toEqual({ ok: true });
    expect(await me.connectMailbox("gw-example")).toMatchObject({
      ok: true,
      mailbox: { proposalsEnabled: false },
    });
    expect((await mail.listMailboxes())[0]!.proposalsEnabled).toBe(false);
    // Anche dal Drive: lo stesso scrittore.
    await drive.disconnectGoogle();
    await drive.connectGoogle();
    expect((await mail.listMailboxes())[0]!.proposalsEnabled).toBe(false);
    // Chi non l'ha mai collegata parte con le proposte accese.
    as("p-marco");
    expect(await me.connectMailbox("gw-example")).toMatchObject({
      mailbox: { proposalsEnabled: true },
    });
  });

  it("senza Workspace sull'istanza l'elenco lo dice (vuoto)", async () => {
    state.googleWorkspaces = [];
    as("p-marco");
    expect(await me.listMyMailboxes()).toEqual({ mailboxes: [], workspaces: [] });
  });
});
