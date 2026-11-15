import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifyOutcome } from "../../domain/servers/sshAccess";
import { failNext, listNotifications, resetApi, servers, setLatency } from "../api";
import { PROJECTS } from "../seed/projects";
import { setSessionPersonId } from "../session";
import { eventsOf, state } from "../store";
import { grantInstancePermission } from "../viewer";
import { markUsed, onAccessRevoked } from "./access";
import { whenAnalysesIdle } from "./analysis";
import { __privateValuesForTest, hasKey } from "./secrets";
import { serversVisibleTo } from "./visibility";

// L'accesso SSH di un server (area 8, F4b, Q3 = b): UNO, di sola lettura
// (`stubwise-read`). Nessuna coppia di correzione: la correzione passa
// dall'agente.

const as = (personId: string) => setSessionPersonId(personId);
const view = async (code: string) => (await servers.getServer(code)).access;
const usable = async (code: string) => (await view(code)).usable;
const verifyWith = async (code: string, outcome: VerifyOutcome) => {
  await servers.simulateSshVerifyOutcome(code, outcome);
  return servers.verifySshAccess(code);
};
/** Ogni valore segreto custodito adesso, piatto. */
const secretValues = () => __privateValuesForTest().flatMap((x) => x.values);
const dumpAccess = () => JSON.stringify([...state.serverAccess.entries()]);
const message = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );
/** Ogni chiave di un oggetto, a ogni livello. */
const keysDeep = (x: unknown): string[] =>
  x === null || typeof x !== "object"
    ? []
    : Object.entries(x).flatMap(([k, v]) => [k, ...keysDeep(v)]);

beforeEach(() => {
  resetApi();
  setLatency(0);
});

afterEach(() => resetApi());

describe("collega → comando → verifica", () => {
  it("i tre passi: SRV-2 non collegato diventa verificato, con una chiave sola", async () => {
    as("p-roberta");
    expect((await view("SRV-2")).state).toBe("not_linked");
    const { command } = await servers.linkSshAccess("SRV-2");
    const linked = await view("SRV-2");
    expect(linked.state).toBe("awaiting_command");
    expect(linked.username).toBe("stubwise-read");
    expect(linked.key).toBeNull();
    expect(command).toContain(linked.pending!.publicKey);
    expect(command).toContain("stubwise-read@SRV-2");
    expect(command).not.toContain("stubwise-fix");
    expect(command.match(/ssh-ed25519/g)).toHaveLength(1);
    expect(command).not.toContain("PRIVATE KEY");
    // Il comando si può rivedere, uguale.
    expect((await servers.getInstallCommand("SRV-2")).command).toBe(command);
    expect(hasKey("SRV-2")).toBe(false);

    const verified = await servers.verifySshAccess("SRV-2");
    expect(verified.state).toBe("verified");
    expect(verified.key).toEqual(linked.pending);
    expect(verified.pending).toBeNull();
    expect(verified.usable).toBe(true);
    expect(verified.journal).toBe(true);
    expect(verified.verification).toMatchObject({
      login: "ok",
      groups: ["stubwise-read", "systemd-journal"],
      sudo: false,
      docker: false,
      journal: true,
      ok: true,
      ofPending: false,
    });
    expect(hasKey("SRV-2")).toBe(true);
  });

  it("collegare è ammesso solo da non collegato o revocato", async () => {
    as("p-roberta");
    for (const code of ["SRV-1", "SRV-3"])
      expect(await message(servers.linkSshAccess(code))).toBe("invalid: state");
    expect(await message(servers.verifySshAccess("SRV-2"))).toBe("invalid: state");
    expect(await message(servers.getInstallCommand("SRV-2"))).toBe("invalid: state");
  });

  it("nessuna chiave `fix` nello stato né nella vista, in nessun passo", async () => {
    as("p-roberta");
    await servers.linkSshAccess("SRV-2");
    await servers.verifySshAccess("SRV-2");
    await servers.regenerateSshAccess("SRV-1");
    for (const code of ["SRV-1", "SRV-2", "SRV-3", "SRV-4"]) {
      const v = await view(code);
      expect(keysDeep(v), code).not.toContain("fix");
      expect(JSON.stringify(v), code).not.toContain("stubwise-fix");
    }
    for (const a of state.serverAccess.values()) expect(keysDeep(a)).not.toContain("fix");
  });
});

describe("esiti della verifica (prototipo)", () => {
  const CASES: [VerifyOutcome, string, Record<string, unknown>, RegExp | null][] = [
    ["ok", "verified", { login: "ok", sudo: false, docker: false, journal: true, ok: true }, null],
    [
      "no_journal",
      "verified",
      { login: "ok", groups: ["stubwise-read"], journal: false, ok: true },
      null,
    ],
    ["denied", "verify_failed", { login: "denied", ok: false }, /Permission denied/],
    [
      "sudo",
      "privileged",
      { login: "ok", sudo: true, docker: false, ok: false, groups: ["stubwise-read", "sudo"] },
      /sudo/,
    ],
    [
      "docker",
      "privileged",
      { login: "ok", sudo: false, docker: true, ok: false, groups: ["stubwise-read", "docker"] },
      /docker/,
    ],
    ["unreachable", "verify_failed", { login: "unreachable", ok: false }, /timed out/],
  ];

  it.each(CASES)("prima verifica di SRV-3, %s → %s", async (outcome, expected, fields, reason) => {
    as("p-roberta");
    const v = await verifyWith("SRV-3", outcome);
    expect(v.state).toBe(expected);
    expect(v.verification).toMatchObject(fields);
    if (reason) expect(v.verification!.reason).toMatch(reason);
    else expect(v.verification!.reason).toBeNull();
    // Solo un utente di sola lettura che entra rende l'accesso usabile.
    expect(v.usable).toBe(outcome === "ok" || outcome === "no_journal");
    expect(v.journal).toBe(outcome === "ok");
  });

  it("un utente con sudo spegne l'accesso finché una verifica non riesce", async () => {
    as("p-roberta");
    expect(await usable("SRV-1")).toBe(true);
    const v = await verifyWith("SRV-1", "sudo");
    expect(v.state).toBe("privileged");
    expect(v.usable).toBe(false);
    // L'esito simulato vale per UNA verifica: la successiva è di nuovo «ok».
    expect((await servers.verifySshAccess("SRV-1")).state).toBe("verified");
    expect(await usable("SRV-1")).toBe(true);
  });

  it("senza il gruppo del journal l'accesso si usa, ma il journal no (F4b-3 = a)", async () => {
    as("p-roberta");
    const v = await verifyWith("SRV-1", "no_journal");
    expect(v).toMatchObject({ state: "verified", usable: true, journal: false });
  });

  it("un server irraggiungibile via SSH dà «irraggiungibile» anche senza simulare", async () => {
    as("p-roberta");
    state.servers.find((s) => s.code === "SRV-1")!.sshReachable = false;
    const v = await servers.verifySshAccess("SRV-1");
    expect(v.verification).toMatchObject({ login: "unreachable", ok: false });
  });
});

describe("rigenera (RF 5; decisione del maintainer, 15 nov 2026: una chiave sola)", () => {
  it("la vecchia smette SUBITO di valere: in attesa del comando, non usabile, la privata dimenticata; verificata la nuova vale", async () => {
    as("p-roberta");
    const before = await view("SRV-1");
    const oldSecrets = __privateValuesForTest().filter((x) => x.slot.startsWith("SRV-1|"));
    const { command } = await servers.regenerateSshAccess("SRV-1");

    const regenerated = await view("SRV-1");
    expect(regenerated.state).toBe("awaiting_command");
    expect(regenerated.usable).toBe(false);
    expect(regenerated.key).toBeNull();
    // Il comando scrive solo la nuova: la vecchia non vale più.
    const newKey = regenerated.pending!.publicKey;
    expect(command).toContain(newKey);
    expect(command).not.toContain(before.key!.publicKey);
    expect(command).not.toContain("PRIVATE KEY");
    expect((await servers.getInstallCommand("SRV-1")).command).toBe(command);
    // La vecchia privata non c'è più già adesso.
    const now = secretValues();
    for (const v of oldSecrets.flatMap((x) => x.values)) expect(now).not.toContain(v);
    expect(hasKey("SRV-1")).toBe(false);

    const failed = await verifyWith("SRV-1", "denied");
    expect(failed.state).toBe("verify_failed");
    expect(failed.usable).toBe(false);

    const ok = await servers.verifySshAccess("SRV-1");
    expect(ok.state).toBe("verified");
    expect(ok.key).toEqual(regenerated.pending);
    expect(ok.pending).toBeNull();
    expect(ok.usable).toBe(true);
    expect(hasKey("SRV-1")).toBe(true);
    expect(__privateValuesForTest().filter((x) => x.slot.startsWith("SRV-1|"))).toHaveLength(1);
  });

  it("finché la nuova non passa, l'analisi gira senza letture SSH", async () => {
    as("p-roberta");
    await servers.regenerateSshAccess("SRV-1");
    await servers.simulateServerAlert("SRV-1", "memory");
    await whenAnalysesIdle();
    const a = state.serverAnalyses.find((x) => x.id.includes("-new-") && x.serverCode === "SRV-1")!;
    const reads = eventsOf(a.conversationId).filter(
      (e) => e.type === "action" && e.serverCommand?.via === "ssh",
    );
    expect(reads).toEqual([]);
  });

  it("una chiave nuova il cui utente ha sudo: spento; la verifica riuscita dopo la accende", async () => {
    as("p-roberta");
    await servers.regenerateSshAccess("SRV-1");
    const pending = (await view("SRV-1")).pending!;
    const priv = await verifyWith("SRV-1", "sudo");
    expect(priv.state).toBe("privileged");
    expect(priv.usable).toBe(false);
    const ok = await servers.verifySshAccess("SRV-1");
    expect(ok.state).toBe("verified");
    expect(ok.key).toEqual(pending);
    expect(ok.usable).toBe(true);
  });

  it("si rigenera solo da verificato, verifica fallita o utente con più della lettura", async () => {
    as("p-roberta");
    expect(await message(servers.regenerateSshAccess("SRV-2"))).toBe("invalid: state");
    expect(await message(servers.regenerateSshAccess("SRV-3"))).toBe("invalid: state");
    await servers.regenerateSshAccess("SRV-1");
    expect(await message(servers.regenerateSshAccess("SRV-1"))).toBe("invalid: state");
    // Dalla prima verifica fallita: chiave nuova in attesa, quella di prima dimenticata.
    await verifyWith("SRV-3", "denied");
    const pendingBefore = (await view("SRV-3")).pending!;
    await servers.regenerateSshAccess("SRV-3");
    const after = await view("SRV-3");
    expect(after.state).toBe("awaiting_command");
    expect(after.pending!.publicKey).not.toBe(pendingBefore.publicKey);
  });
});

describe("revoca", () => {
  it("dimentica la chiave, dà il comando di rimozione, ferma l'analisi; si può ricollegare", async () => {
    const stopped: string[] = [];
    const off = onAccessRevoked((code) => stopped.push(code));
    // Un gancio che lancia non fa fallire una revoca già avvenuta.
    const offBroken = onAccessRevoked(() => {
      throw new Error("boom");
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    as("p-roberta");
    const { removalCommand } = await servers.revokeSshAccess("SRV-1").finally(() => {
      off();
      offBroken();
    });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
    expect(removalCommand).toContain("userdel stubwise-read");
    expect(removalCommand).not.toContain("stubwise-fix");
    expect(removalCommand).not.toContain("ssh-ed25519");
    expect(stopped).toEqual(["SRV-1"]);
    const v = await view("SRV-1");
    expect(v).toMatchObject({ state: "revoked", key: null, pending: null, usable: false });
    expect(state.serverAccess.get("SRV-1")!.revokedAt).not.toBeNull();
    expect(hasKey("SRV-1")).toBe(false);
    expect(__privateValuesForTest().some((x) => x.slot.startsWith("SRV-1|"))).toBe(false);
    expect(await message(servers.revokeSshAccess("SRV-1"))).toBe("invalid: state");
    expect(await message(servers.verifySshAccess("SRV-1"))).toBe("invalid: state");

    // Un esito simulato prima del collegamento non vale per la prima verifica dopo.
    await servers.simulateSshVerifyOutcome("SRV-1", "sudo");
    await servers.linkSshAccess("SRV-1");
    expect((await view("SRV-1")).state).toBe("awaiting_command");
    expect((await servers.verifySshAccess("SRV-1")).state).toBe("verified");
    // Disiscritto: una revoca dopo non lo chiama più.
    await servers.revokeSshAccess("SRV-1");
    expect(stopped).toEqual(["SRV-1"]);
  });

  it("revocare un accesso mai collegato non ha senso", async () => {
    as("p-roberta");
    expect(await message(servers.revokeSshAccess("SRV-2"))).toBe("invalid: state");
  });

  it("togliere il server dimentica anche la chiave", async () => {
    as("p-roberta");
    await servers.deleteServer("SRV-1");
    expect(state.serverAccess.has("SRV-1")).toBe(false);
    expect(__privateValuesForTest().some((x) => x.slot.startsWith("SRV-1|"))).toBe(false);
  });
});

describe("permessi e R-G5", () => {
  const WRITES: [string, (code: string) => Promise<unknown>][] = [
    ["linkSshAccess", (c) => servers.linkSshAccess(c)],
    ["getInstallCommand", (c) => servers.getInstallCommand(c)],
    ["getRemovalCommand", (c) => servers.getRemovalCommand(c)],
    ["verifySshAccess", (c) => servers.verifySshAccess(c)],
    ["regenerateSshAccess", (c) => servers.regenerateSshAccess(c)],
    ["revokeSshAccess", (c) => servers.revokeSshAccess(c)],
    ["simulateSshVerifyOutcome", (c) => servers.simulateSshVerifyOutcome(c, "sudo")],
  ];

  it.each(["p-laura", "p-marco"])(
    "%s → forbidden su ogni scrittura, nessun cambiamento",
    async (who) => {
      as(who);
      expect(serversVisibleTo(who).has("SRV-1")).toBe(true);
      const before = dumpAccess();
      for (const code of ["SRV-1", "SRV-3"].filter((c) => serversVisibleTo(who).has(c)))
        for (const [name, write] of WRITES)
          expect(await message(write(code)), `${name} ${code}`).toBe("forbidden");
      expect(dumpAccess()).toBe(before);
      expect(state.sshVerifyNext.size).toBe(0);
    },
  );

  it("Sara (membro di ACQ) vede lo stato e l'ultimo uso, senza azioni", async () => {
    as("p-sara");
    const v = await view("SRV-1");
    expect(v.state).toBe("verified");
    expect(v.canManage).toBe(false);
    expect(v.key!.publicKey).toContain("stubwise-read@SRV-1");
    expect(v.lastUse).toEqual({
      at: expect.any(String),
      label: { kind: "analysis", code: "ACQ-6" },
      sessionId: expect.any(String),
    });
    as("p-roberta");
    expect((await view("SRV-1")).canManage).toBe(true);
  });

  it("R-G5: un server nascosto risponde come uno inesistente, anche con servers.ssh.manage", async () => {
    grantInstancePermission("p-sara", "servers.ssh.manage");
    as("p-sara");
    const before = dumpAccess();
    for (const [name, write] of WRITES) {
      const hidden = await message(write("SRV-3"));
      expect(hidden, name).toBe("not_found");
      expect(await message(write("SRV-99")), name).toBe(hidden);
    }
    expect(dumpAccess()).toBe(before);
    // Su un server che vede, col permesso, agisce.
    expect((await servers.linkSshAccess("SRV-2")).command).toContain("stubwise-read@SRV-2");
  });

  it("senza servers.ssh.manage: not_found prima di forbidden", async () => {
    as("p-sara");
    for (const [name, write] of WRITES) {
      expect(await message(write("SRV-3")), name).toBe("not_found");
      expect(await message(write("SRV-1")), name).toBe("forbidden");
    }
  });
});

describe("comando di rimozione", () => {
  it("dopo la revoca si rilegge uguale al risultato di revokeSshAccess; prima no", async () => {
    as("p-roberta");
    expect(await message(servers.getRemovalCommand("SRV-1"))).toBe("invalid: state");
    const { removalCommand } = await servers.revokeSshAccess("SRV-1");
    expect((await servers.getRemovalCommand("SRV-1")).command).toBe(removalCommand);
    // Ricollegato non è più revocato: il comando di rimozione non c'è più.
    await servers.linkSshAccess("SRV-1");
    expect(await message(servers.getRemovalCommand("SRV-1"))).toBe("invalid: state");
  });
});

describe("ultimo uso", () => {
  it("l'analisi attribuita a un progetto che chi guarda non vede: niente sessione (R-G5)", async () => {
    // L'analisi di SRV-1 attribuita a un progetto che Sara non vede: la sessione è lì.
    const aud = PROJECTS.find((p) => p.code === "AUD")!;
    const a = state.serverAnalyses.find((x) => x.id === "an-srv-1-1")!;
    a.attribution = { kind: "attributed", projectId: aud.id, projectCode: aud.code };
    state.conversations.find((c) => c.id === a.conversationId)!.projectId = aud.id;
    as("p-sara");
    const use = (await view("SRV-1")).lastUse!;
    expect(use.label!.kind).toBe("analysis");
    expect(use.sessionId).toBeNull();
    // Chi lo vede ha la sessione.
    as("p-roberta");
    expect((await view("SRV-1")).lastUse!.sessionId).toEqual(expect.any(String));
  });

  it("markUsed registra l'uso; il codice della task solo se chi guarda la vede", async () => {
    const task = state.tasks.find((t) => t.code === "ACQ-6")!;
    markUsed("SRV-1", { kind: "task", taskId: task.id });
    as("p-sara");
    expect((await view("SRV-1")).lastUse).toEqual({
      at: expect.any(String),
      label: { kind: "task", code: "ACQ-6" },
      sessionId: null,
    });
    // Una task di un progetto che Sara non vede: l'uso c'è, il codice no.
    const aud = PROJECTS.find((p) => p.code === "AUD")!;
    const hidden = state.tasks.find((t) => t.projectId === aud.id)!;
    markUsed("SRV-1", { kind: "task", taskId: hidden.id });
    expect((await view("SRV-1")).lastUse!.label).toEqual({ kind: "task", code: null });
  });
});

describe("RF 2: le chiavi private non escono", () => {
  it("dopo collega, verifica, rigenera e revoca nessuna lettura contiene una privata", async () => {
    as("p-roberta");
    const seen = new Set<string>(secretValues());
    const reads = async () => {
      const out: unknown[] = [];
      for (const code of serversVisibleTo("p-roberta")) {
        out.push(await servers.getServer(code));
        out.push(await servers.getInstallCommand(code).catch((e: Error) => e.message));
        out.push(await servers.getRemovalCommand(code).catch((e: Error) => e.message));
      }
      for (const p of PROJECTS) out.push(await servers.listProjectServers(p.id));
      out.push(await servers.searchServers("srv"));
      out.push(await listNotifications());
      return JSON.stringify(out);
    };
    const check = async (step: string) => {
      for (const v of secretValues()) seen.add(v);
      const text = await reads();
      // Anche lo stato condiviso non le ha mai: stanno solo in `secrets.ts`.
      const dump = JSON.stringify(state, (_, v: unknown) =>
        v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v] : v,
      );
      expect(text, step).not.toContain("PRIVATE KEY");
      expect(dump, step).not.toContain("PRIVATE KEY");
      for (const s of seen) {
        expect(text.includes(s), step).toBe(false);
        expect(dump.includes(s), step).toBe(false);
      }
    };
    await check("seme");
    const linked = await servers.linkSshAccess("SRV-2");
    expect(linked.command).not.toContain("PRIVATE KEY");
    await check("collega");
    await servers.verifySshAccess("SRV-2");
    await check("verifica");
    const regen = await servers.regenerateSshAccess("SRV-1");
    expect(regen.command).not.toContain("PRIVATE KEY");
    await check("rigenera");
    await verifyWith("SRV-1", "denied");
    await servers.verifySshAccess("SRV-1");
    await check("verifica della nuova");
    const { removalCommand } = await servers.revokeSshAccess("SRV-2");
    for (const s of seen) expect(removalCommand.includes(s)).toBe(false);
    await check("revoca");
    expect(seen.size).toBeGreaterThan(4);
  });
});

describe("failNext e resetApi", () => {
  it("failNext rifiuta solo la chiamata successiva, senza scrivere", async () => {
    as("p-roberta");
    failNext("servers.linkSshAccess");
    await expect(servers.linkSshAccess("SRV-2")).rejects.toThrow("Simulated failure");
    expect(state.serverAccess.has("SRV-2")).toBe(false);
    await servers.linkSshAccess("SRV-2");
    failNext("servers.verifySshAccess");
    await expect(servers.verifySshAccess("SRV-2")).rejects.toThrow("Simulated failure");
    expect((await view("SRV-2")).state).toBe("awaiting_command");
  });

  it("una scrittura partita prima di resetApi non scrive", async () => {
    as("p-roberta");
    setLatency(20);
    const pending = servers.linkSshAccess("SRV-2");
    resetApi();
    await expect(pending).rejects.toThrow("reset");
    expect(state.serverAccess.has("SRV-2")).toBe(false);
  });

  it("resetApi rimette accessi e chiavi del seme", async () => {
    const seed = JSON.stringify(__privateValuesForTest());
    const seedAccess = dumpAccess();
    as("p-roberta");
    await servers.linkSshAccess("SRV-2");
    await servers.regenerateSshAccess("SRV-1");
    await servers.revokeSshAccess("SRV-3");
    await servers.simulateSshVerifyOutcome("SRV-1", "sudo");
    resetApi();
    expect(dumpAccess()).toBe(seedAccess);
    expect(JSON.stringify(__privateValuesForTest())).toBe(seed);
    expect(state.sshVerifyNext.size).toBe(0);
    expect(hasKey("SRV-1")).toBe(true);
    expect(hasKey("SRV-3")).toBe(false);
  });
});
