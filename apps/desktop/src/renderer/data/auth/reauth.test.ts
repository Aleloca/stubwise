import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auth, failNext, resetApi, setLatency } from "../api";
import { accessState } from "../access/index";
import { __secretValuesForTest, secretIdsOf } from "../admin/secrets";
import { setSessionPersonId } from "../session";
import { advanceNow, now, state, type ApiFnName } from "../store";
import * as reauthModule from "./reauth";
import {
  PROTOTYPE_TOTP_CODE,
  REAUTH_GRACE_MINUTES,
  REAUTH_REQUIRED,
  hasFreshReauth,
  requireReauth,
} from "./reauth";

// La riconferma col secondo fattore (area 9a, Task 3).

/**
 * Il registro delle funzioni delicate: quelle marcate «+R» nei Task 4 e 5
 * del piano 9a. Ogni task che ne aggiunge una la aggiunge QUI, nello stesso
 * commit in cui entra in `REAUTH_REQUIRED` e in `ApiFnName`.
 */
const EXPECTED_REAUTH: readonly ApiFnName[] = [
  // Task 4: People, inviti, Roles, Departments, Members
  "admin.setInstanceRole",
  "admin.createPasswordResetLink",
  "admin.resetSecondFactor",
  "admin.unlinkGitIdentity",
  "admin.deactivatePerson",
  "admin.createInvite",
  "admin.createRole",
  "admin.updateRole",
  "admin.duplicateRole",
  "admin.deleteRole",
  "admin.setDepartmentMembers",
  "admin.setHomeManagers",
  "admin.setDepartmentPermissions",
  "admin.addMember",
  "admin.removeMember",
  "admin.setMemberRole",
  "admin.grantMemberPermission",
  "admin.revokeMemberPermission",
];

const as = (personId: string) => setSessionPersonId(personId);
const MINUTE = 60_000;
const message = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );
/** Il primo codice di backup del seme di una persona. */
const firstBackupCode = (personId: string) => {
  const id = secretIdsOf("backup_codes", personId)[0]!;
  return __secretValuesForTest().find((s) => s.id === id)!.values[1]!;
};

/** Una funzione delicata finta, dichiarata solo per la durata di `fn`. */
async function withDeclared<T>(fn: (name: ApiFnName) => Promise<T> | T): Promise<T> {
  const name = "test.sensitive" as ApiFnName;
  const set = REAUTH_REQUIRED as Set<ApiFnName>;
  set.add(name);
  try {
    return await fn(name);
  } finally {
    set.delete(name);
  }
}

beforeEach(() => {
  resetApi();
  setLatency(0);
});
afterEach(() => resetApi());

describe("registro", () => {
  it("REAUTH_REQUIRED è esattamente l'elenco delle funzioni +R del piano", () => {
    expect([...REAUTH_REQUIRED].sort()).toEqual([...EXPECTED_REAUTH].sort());
  });

  it("un PAT non la soddisfa mai: il prototipo non ha chiamate via PAT", () => {
    // Ogni chiamata è di una sessione (`gate` legge la persona della
    // sessione); l'unica strada per la finestra di grazia è un secondo
    // fattore verificato, e non c'è nessuna funzione che la apra da un token.
    const names = Object.keys(reauthModule);
    expect(names.filter((n) => /pat|token/i.test(n))).toEqual([]);
  });
});

describe("requireReauth", () => {
  it("una funzione non dichiarata passa anche senza riconferma", () => {
    expect(requireReauth("p-laura", "listPeople")).toBeNull();
  });

  it("una funzione dichiarata senza riconferma → reauth_required, e niente cambia", async () => {
    await withDeclared((fn) => {
      const before = JSON.stringify([...state.reauth, ...state.secondFactorAttempts]);
      const changelog = state.changelog.length;
      expect(requireReauth("p-laura", fn)).toBe("reauth_required");
      expect(JSON.stringify([...state.reauth, ...state.secondFactorAttempts])).toBe(before);
      expect(state.changelog.length).toBe(changelog);
    });
  });

  it("con il codice 123456 passa", async () => {
    as("p-laura");
    expect(PROTOTYPE_TOTP_CODE).toBe("123456");
    await withDeclared(async (fn) => {
      expect(await auth.reauthenticate({ method: "totp", code: "123456" })).toEqual({ ok: true });
      expect(requireReauth("p-laura", fn)).toBeNull();
    });
  });

  it("con una passkey passa; con un codice di backup passa una volta sola", async () => {
    as("p-roberta");
    expect(await auth.reauthenticate({ method: "passkey" })).toEqual({ ok: true });
    expect(hasFreshReauth("p-roberta")).toBe(true);

    as("p-marco");
    const code = firstBackupCode("p-marco");
    expect(await auth.reauthenticate({ method: "backup_code", code })).toEqual({ ok: true });
    expect(
      accessState().people.find((p) => p.personId === "p-marco")!.secondFactor!.backupCodesLeft,
    ).toBe(9);
    expect(await auth.reauthenticate({ method: "backup_code", code })).toMatchObject({
      ok: false,
      error: "invalid_code",
    });
  });

  it("il codice di backup di un altro non vale", async () => {
    const lauraCode = firstBackupCode("p-laura");
    as("p-marco");
    expect(await auth.reauthenticate({ method: "backup_code", code: lauraCode })).toMatchObject({
      ok: false,
      error: "invalid_code",
    });
  });

  it("dopo 10 minuti esatti di now() passa ancora, dopo 10:01 no", async () => {
    as("p-laura");
    await auth.reauthenticate({ method: "totp", code: "123456" });
    await withDeclared((fn) => {
      advanceNow(REAUTH_GRACE_MINUTES * MINUTE);
      // `now()` spostato tiene il formato dell'orologio fermo.
      expect(now()).toBe("2026-10-23T12:10:00Z");
      expect(requireReauth("p-laura", fn)).toBeNull();
      advanceNow(1_000);
      expect(requireReauth("p-laura", fn)).toBe("reauth_required");
    });
  });

  it("la finestra è per persona: cambiare persona e tornare la ritrova, per l'altra non vale", async () => {
    as("p-laura");
    await auth.reauthenticate({ method: "totp", code: "123456" });
    as("p-marco");
    await withDeclared((fn) => {
      expect(requireReauth("p-marco", fn)).toBe("reauth_required");
      as("p-laura");
      expect(requireReauth("p-laura", fn)).toBeNull();
    });
  });

  it("un codice sbagliato non apre la finestra", async () => {
    as("p-laura");
    expect(await auth.reauthenticate({ method: "totp", code: "000000" })).toEqual({
      ok: false,
      error: "invalid_code",
      triesLeft: 4,
    });
    expect(hasFreshReauth("p-laura")).toBe(false);
  });
});

describe("blocco", () => {
  it("5 codici sbagliati → locked per 15 minuti, anche col codice giusto; poi si riparte", async () => {
    as("p-laura");
    for (let i = 4; i >= 1; i--)
      expect(await auth.reauthenticate({ method: "totp", code: "000000" })).toEqual({
        ok: false,
        error: "invalid_code",
        triesLeft: i,
      });
    expect(await auth.reauthenticate({ method: "totp", code: "000000" })).toEqual({
      ok: false,
      error: "locked",
      lockedUntil: "2026-10-23T12:15:00Z",
    });
    expect(await auth.reauthenticate({ method: "totp", code: "123456" })).toMatchObject({
      ok: false,
      error: "locked",
    });
    expect(await auth.reauthenticate({ method: "passkey" })).toMatchObject({ error: "locked" });
    expect(hasFreshReauth("p-laura")).toBe(false);
    // Il blocco è di Laura, non di Marco.
    as("p-marco");
    expect(await auth.reauthenticate({ method: "totp", code: "123456" })).toEqual({ ok: true });
    as("p-laura");
    advanceNow(15 * MINUTE);
    expect(await auth.reauthenticate({ method: "totp", code: "123456" })).toEqual({ ok: true });
  });

  it("un codice giusto azzera il conto", async () => {
    as("p-laura");
    for (let i = 0; i < 4; i++) await auth.reauthenticate({ method: "totp", code: "000000" });
    expect(await auth.reauthenticate({ method: "totp", code: "123456" })).toEqual({ ok: true });
    expect(await auth.reauthenticate({ method: "totp", code: "000000" })).toMatchObject({
      triesLeft: 4,
    });
  });
});

describe("senza secondo fattore", () => {
  it("Sara riceve no_second_factor, e l'iscrizione al volo le dà il segreto una volta", async () => {
    as("p-sara");
    expect(await auth.reauthenticate({ method: "totp", code: "123456" })).toEqual({
      ok: false,
      error: "no_second_factor",
    });
    const setup = await auth.enrollDuringReauth();
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.uri).toContain(setup.secret);
    expect(__secretValuesForTest().filter((s) => s.kind === "totp_seed")).toHaveLength(1);
    // Rifarla dimentica il segreto di prima.
    const again = await auth.enrollDuringReauth();
    expect(again.secret).not.toBe(setup.secret);
    expect(
      __secretValuesForTest()
        .filter((s) => s.kind === "totp_seed")
        .map((s) => s.values[0]),
    ).toEqual([again.secret]);
    expect(hasFreshReauth("p-sara")).toBe(false);
  });

  it("chi ha già il secondo fattore non si iscrive di nuovo; Claude nemmeno", async () => {
    as("p-laura");
    expect(await message(auth.enrollDuringReauth())).toBe("invalid: already_enrolled");
    as("p-claude");
    expect(await message(auth.enrollDuringReauth())).toBe("forbidden");
  });

  it("failNext", async () => {
    as("p-laura");
    failNext("auth.reauthenticate");
    expect(await message(auth.reauthenticate({ method: "passkey" }))).toMatch(/Simulated failure/);
    expect(hasFreshReauth("p-laura")).toBe(false);
  });
});

describe("resetApi", () => {
  it("dimentica finestre, blocchi e orologio", async () => {
    as("p-laura");
    await auth.reauthenticate({ method: "totp", code: "123456" });
    as("p-marco");
    for (let i = 0; i < 5; i++) await auth.reauthenticate({ method: "totp", code: "000000" });
    advanceNow(MINUTE);
    resetApi();
    setLatency(0);
    expect(state.reauth.size).toBe(0);
    expect(state.secondFactorAttempts.size).toBe(0);
    as("p-marco");
    expect(await auth.reauthenticate({ method: "totp", code: "123456" })).toEqual({ ok: true });
    expect(state.reauth.get("p-marco")).toBe("2026-10-23T12:00:00Z");
  });
});
