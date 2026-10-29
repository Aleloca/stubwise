import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifyOutcome } from "../../domain/servers/sshAccess";
import { failNext, listNotifications, resetApi, servers, setLatency } from "../api";
import { PROJECTS } from "../seed/projects";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { grantInstancePermission } from "../viewer";
import { markUsed, onAccessRevoked } from "./access";
import { __privateValuesForTest, hasKey } from "./secrets";
import { serversVisibleTo } from "./visibility";

const as = (personId: string) => setSessionPersonId(personId);
const view = async (code: string) => (await servers.getServer(code)).access;
const usable = async (code: string) => {
  const v = await view(code);
  return [v.usable.read, v.usable.fix];
};
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

beforeEach(() => {
  resetApi();
  setLatency(0);
});

afterEach(() => resetApi());

describe("collega → comando → verifica", () => {
  it("i tre passi: SRV-2 non collegato diventa verificato", async () => {
    as("p-roberta");
    expect((await view("SRV-2")).state).toBe("not_linked");
    const { command } = await servers.linkSshAccess("SRV-2");
    const linked = await view("SRV-2");
    expect(linked.state).toBe("awaiting_command");
    expect(linked.read).toBeNull();
    expect(command).toContain(linked.pending!.read.publicKey);
    expect(command).toContain(linked.pending!.fix.publicKey);
    expect(command).toContain("stubwise-read@SRV-2");
    expect(command).toContain("stubwise-fix@SRV-2");
    expect(command).not.toContain("PRIVATE KEY");
    // Il comando si può rivedere, uguale.
    expect((await servers.getInstallCommand("SRV-2")).command).toBe(command);
    expect(hasKey("SRV-2", "read")).toBe(false);

    const verified = await servers.verifySshAccess("SRV-2");
    expect(verified.state).toBe("verified");
    expect(verified.read).toEqual(linked.pending!.read);
    expect(verified.fix).toEqual(linked.pending!.fix);
    expect(verified.pending).toBeNull();
    expect(verified.usable).toEqual({ read: true, fix: true });
    expect(verified.verification).toMatchObject({ read: "ok", fix: "ok", ofPending: false });
    expect(hasKey("SRV-2", "read") && hasKey("SRV-2", "fix")).toBe(true);
  });

  it("collegare è ammesso solo da non collegato o revocato", async () => {
    as("p-roberta");
    for (const code of ["SRV-1", "SRV-3"])
      expect(await message(servers.linkSshAccess(code))).toBe("invalid: state");
    expect(await message(servers.verifySshAccess("SRV-2"))).toBe("invalid: state");
    expect(await message(servers.getInstallCommand("SRV-2"))).toBe("invalid: state");
  });
});

describe("esiti della verifica (prototipo)", () => {
  const CASES: [VerifyOutcome, string, Record<string, unknown>, RegExp | null][] = [
    ["ok", "verified", { read: "ok", fix: "ok" }, null],
    ["read_fails", "verify_failed", { read: "failed", fix: "ok" }, /stubwise-read/],
    ["fix_fails", "verify_failed", { read: "ok", fix: "failed" }, /stubwise-fix/],
    ["read_writes", "read_writes", { read: "writes", fix: "ok" }, /sudo -n true/],
    ["unreachable", "verify_failed", { read: "failed", fix: "failed" }, /timed out/],
  ];

  it.each(CASES)("prima verifica di SRV-3, %s → %s", async (outcome, expected, fields, reason) => {
    as("p-roberta");
    const v = await verifyWith("SRV-3", outcome);
    expect(v.state).toBe(expected);
    expect(v.verification).toMatchObject(fields);
    if (reason) expect(v.verification!.reason).toMatch(reason);
    else expect(v.verification!.reason).toBeNull();
    // Solo «ok» rende usabile qualcosa: le chiavi in attesa non sono in uso.
    const ok = outcome === "ok";
    expect(v.usable).toEqual({ read: ok, fix: ok });
  });

  it("una lettura che scrive spegne entrambi finché una verifica non riesce", async () => {
    as("p-roberta");
    expect(await usable("SRV-1")).toEqual([true, true]);
    const v = await verifyWith("SRV-1", "read_writes");
    expect(v.state).toBe("read_writes");
    expect(v.usable).toEqual({ read: false, fix: false });
    // L'esito simulato vale per UNA verifica: la successiva è di nuovo «ok».
    expect((await servers.verifySshAccess("SRV-1")).state).toBe("verified");
    expect(await usable("SRV-1")).toEqual([true, true]);
  });

  it("un server irraggiungibile via SSH dà «irraggiungibile» anche senza simulare", async () => {
    as("p-roberta");
    state.servers.find((s) => s.code === "SRV-1")!.sshReachable = false;
    const v = await servers.verifySshAccess("SRV-1");
    expect(v.verification).toMatchObject({ read: "failed", fix: "failed" });
  });
});

describe("rigenera (RF 5)", () => {
  it("le vecchie valgono durante la rigenerazione; fallita restano, riuscita le nuove e le vecchie dimenticate", async () => {
    as("p-roberta");
    const before = await view("SRV-1");
    const oldSecrets = __privateValuesForTest().filter((x) => x.slot.startsWith("SRV-1|"));
    const { command } = await servers.regenerateSshAccess("SRV-1");

    const regenerating = await view("SRV-1");
    expect(regenerating.state).toBe("regenerating");
    expect(regenerating.usable).toEqual({ read: true, fix: true });
    expect(regenerating.read).toEqual(before.read);
    // R-L8: il comando autorizza la vecchia E la nuova di ogni utente, così
    // incollarlo non toglie le chiavi che il modello dà ancora usabili.
    const keysOf = (v: typeof before) => [v.read!, v.fix!].map((k) => k.publicKey);
    const newKeys = [regenerating.pending!.read, regenerating.pending!.fix].map((k) => k.publicKey);
    for (const k of [...keysOf(before), ...newKeys]) expect(command).toContain(k);
    expect(command).not.toContain("PRIVATE KEY");
    expect((await servers.getInstallCommand("SRV-1")).command).toBe(command);

    const failed = await verifyWith("SRV-1", "fix_fails");
    expect(failed.state).toBe("verify_failed");
    expect(failed.read).toEqual(before.read);
    expect(failed.usable).toEqual({ read: true, fix: true });
    expect(secretValues()).toEqual(expect.arrayContaining(oldSecrets.flatMap((x) => x.values)));
    // Fallita la verifica, il comando resta quello con le due generazioni.
    expect((await servers.getInstallCommand("SRV-1")).command).toBe(command);

    const ok = await servers.verifySshAccess("SRV-1");
    expect(ok.state).toBe("verified");
    expect(ok.read).toEqual(regenerating.pending!.read);
    expect(ok.fix).toEqual(regenerating.pending!.fix);
    expect(ok.pending).toBeNull();
    // Riuscita: le vecchie private distrutte (la vecchia pubblica rimasta
    // sul server è innocua: nessuno ha più la privata).
    const now = secretValues();
    for (const v of oldSecrets.flatMap((x) => x.values)) expect(now).not.toContain(v);
    expect(__privateValuesForTest().filter((x) => x.slot.startsWith("SRV-1|"))).toHaveLength(2);
    expect(hasKey("SRV-1", "read") && hasKey("SRV-1", "fix")).toBe(true);
    // Il comando dopo scrive solo le chiavi correnti.
    const after = (await servers.getInstallCommand("SRV-1")).command;
    for (const k of newKeys) expect(after).toContain(k);
    for (const k of keysOf(before)) expect(after).not.toContain(k);
    // La Rigenera successiva: correnti + nuovissime, mai le dimenticate.
    const next = (await servers.regenerateSshAccess("SRV-1")).command;
    const third = (await view("SRV-1")).pending!;
    for (const k of [...newKeys, third.read.publicKey, third.fix.publicKey])
      expect(next).toContain(k);
    for (const k of keysOf(before)) expect(next).not.toContain(k);
  });

  it("una seconda Rigenera scarta le nuove mai verificate, anche dal comando", async () => {
    as("p-roberta");
    const before = await view("SRV-1");
    await servers.regenerateSshAccess("SRV-1");
    await verifyWith("SRV-1", "read_fails");
    const discarded = (await view("SRV-1")).pending!;
    const { command } = await servers.regenerateSshAccess("SRV-1");
    expect(command).toContain(before.read!.publicKey);
    expect(command).not.toContain(discarded.read.publicKey);
    expect(command).not.toContain(discarded.fix.publicKey);
    // In vault: le correnti e le nuove in attesa, niente delle scartate.
    expect(__privateValuesForTest().filter((x) => x.slot.startsWith("SRV-1|"))).toHaveLength(4);
  });

  it("nuove chiavi che scrivono: entrambi spenti; la verifica riuscita dopo le promuove", async () => {
    as("p-roberta");
    await servers.regenerateSshAccess("SRV-1");
    const pending = (await view("SRV-1")).pending!;
    const writes = await verifyWith("SRV-1", "read_writes");
    expect(writes.state).toBe("read_writes");
    expect(writes.usable).toEqual({ read: false, fix: false });
    const ok = await servers.verifySshAccess("SRV-1");
    expect(ok.state).toBe("verified");
    expect(ok.read).toEqual(pending.read);
    expect(ok.usable).toEqual({ read: true, fix: true });
  });

  it("Minor 4: una fix già fallita non torna usabile rigenerando, nemmeno dopo una verifica fallita delle nuove", async () => {
    as("p-roberta");
    await verifyWith("SRV-1", "fix_fails");
    expect(await usable("SRV-1")).toEqual([true, false]);
    await servers.regenerateSshAccess("SRV-1");
    expect(await usable("SRV-1")).toEqual([true, false]);
    await verifyWith("SRV-1", "read_fails");
    expect(await usable("SRV-1")).toEqual([true, false]);
    // Un secondo tentativo fallito non perde l'esito delle vecchie.
    await verifyWith("SRV-1", "unreachable");
    expect(await usable("SRV-1")).toEqual([true, false]);
    // Rigenerare di nuovo riporta la verifica sulle chiavi in uso (fix fallita).
    await servers.regenerateSshAccess("SRV-1");
    const again = await view("SRV-1");
    expect(again.state).toBe("regenerating");
    expect(again.verification).toMatchObject({ fix: "failed", ofPending: false });
    expect(await usable("SRV-1")).toEqual([true, false]);
    await servers.verifySshAccess("SRV-1");
    expect(await usable("SRV-1")).toEqual([true, true]);
  });

  it("una lettura che scriveva resta spenta durante la rigenerazione finché una verifica non riesce", async () => {
    as("p-roberta");
    await verifyWith("SRV-1", "read_writes");
    await servers.regenerateSshAccess("SRV-1");
    await verifyWith("SRV-1", "fix_fails");
    expect((await view("SRV-1")).state).toBe("read_writes");
    expect(await usable("SRV-1")).toEqual([false, false]);
    expect((await servers.verifySshAccess("SRV-1")).state).toBe("verified");
  });

  it("si rigenera solo da verificato, verifica fallita o lettura che scrive", async () => {
    as("p-roberta");
    expect(await message(servers.regenerateSshAccess("SRV-2"))).toBe("invalid: state");
    expect(await message(servers.regenerateSshAccess("SRV-3"))).toBe("invalid: state");
    await servers.regenerateSshAccess("SRV-1");
    expect(await message(servers.regenerateSshAccess("SRV-1"))).toBe("invalid: state");
    // Dalla prima verifica fallita: chiavi nuove in attesa, quelle di prima dimenticate.
    await verifyWith("SRV-3", "read_fails");
    const pendingBefore = (await view("SRV-3")).pending!;
    await servers.regenerateSshAccess("SRV-3");
    const after = await view("SRV-3");
    expect(after.state).toBe("awaiting_command");
    expect(after.pending!.read.publicKey).not.toBe(pendingBefore.read.publicKey);
  });
});

describe("revoca", () => {
  it("dimentica le chiavi, dà il comando di rimozione, ferma chi lavora; si può ricollegare", async () => {
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
    expect(removalCommand).toContain("userdel stubwise-fix");
    expect(removalCommand).not.toContain("ssh-ed25519");
    expect(stopped).toEqual(["SRV-1"]);
    const v = await view("SRV-1");
    expect(v).toMatchObject({ state: "revoked", read: null, fix: null, pending: null });
    expect(v.usable).toEqual({ read: false, fix: false });
    expect(state.serverAccess.get("SRV-1")!.revokedAt).not.toBeNull();
    expect(hasKey("SRV-1", "read") || hasKey("SRV-1", "fix")).toBe(false);
    expect(__privateValuesForTest().some((x) => x.slot.startsWith("SRV-1|"))).toBe(false);
    expect(await message(servers.revokeSshAccess("SRV-1"))).toBe("invalid: state");
    expect(await message(servers.verifySshAccess("SRV-1"))).toBe("invalid: state");

    // Un esito simulato prima del collegamento non vale per la prima verifica dopo.
    await servers.simulateSshVerifyOutcome("SRV-1", "read_writes");
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

  it("togliere il server dimentica anche le chiavi", async () => {
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
    ["verifySshAccess", (c) => servers.verifySshAccess(c)],
    ["regenerateSshAccess", (c) => servers.regenerateSshAccess(c)],
    ["revokeSshAccess", (c) => servers.revokeSshAccess(c)],
    ["simulateSshVerifyOutcome", (c) => servers.simulateSshVerifyOutcome(c, "read_writes")],
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
    expect(v.read!.publicKey).toContain("stubwise-read@SRV-1");
    expect(v.lastUse.read).toEqual({
      at: expect.any(String),
      label: { kind: "analysis", code: "ACQ-6" },
    });
    expect(v.lastUse.fix).toBeNull();
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

describe("ultimo uso", () => {
  it("markUsed registra l'uso; il codice della task solo se chi guarda la vede", async () => {
    const task = state.tasks.find((t) => t.code === "ACQ-6")!;
    markUsed("SRV-1", "fix", { kind: "task", taskId: task.id });
    as("p-sara");
    expect((await view("SRV-1")).lastUse.fix).toEqual({
      at: expect.any(String),
      label: { kind: "task", code: "ACQ-6" },
    });
    // Una task di un progetto che Sara non vede: l'uso c'è, il codice no.
    const aud = PROJECTS.find((p) => p.code === "AUD")!;
    const hidden = state.tasks.find((t) => t.projectId === aud.id)!;
    markUsed("SRV-1", "fix", { kind: "task", taskId: hidden.id });
    expect((await view("SRV-1")).lastUse.fix!.label).toEqual({ kind: "task", code: null });
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
    await verifyWith("SRV-1", "fix_fails");
    await servers.verifySshAccess("SRV-1");
    await check("verifica delle nuove");
    const { removalCommand } = await servers.revokeSshAccess("SRV-2");
    for (const s of seen) expect(removalCommand.includes(s)).toBe(false);
    await check("revoca");
    expect(seen.size).toBeGreaterThan(8);
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
    await servers.simulateSshVerifyOutcome("SRV-1", "read_writes");
    resetApi();
    expect(dumpAccess()).toBe(seedAccess);
    expect(JSON.stringify(__privateValuesForTest())).toBe(seed);
    expect(state.sshVerifyNext.size).toBe(0);
    expect(hasKey("SRV-1", "read")).toBe(true);
    expect(hasKey("SRV-3", "read")).toBe(false);
  });
});
