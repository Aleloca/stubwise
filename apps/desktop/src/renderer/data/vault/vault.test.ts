import { beforeEach, describe, expect, it } from "vitest";
import { resetApi, setLatency, vault } from "../api";
import { markReauthenticated } from "../auth/reauth";
import { VAULT_IDS } from "../seed/vault";
import { setSessionPersonId } from "../session";
import { state } from "../store";
import { setVaultClipboard } from "./index";

// Lotto 10, shape `vault.md` (decisioni del maintainer del 24–25 nov 2026):
// il livello dati della Cassaforte nel prototipo. Chi legge lo dicono le
// regole del server; la chiave del Mac la finge `thisMac`.

const { ARUBA, CLOUDFLARE, MAILGUN, STRIPE, FIGMA } = VAULT_IDS;
const as = (id: string) => setSessionPersonId(id);
let clip = "";

beforeEach(() => {
  setLatency(0);
  resetApi();
  clip = "";
  setVaultClipboard({ write: (t) => void (clip = t), read: () => clip });
});

describe("chi vede e chi legge", () => {
  it("Laura in ACQ: legge Aruba e Cloudflare, gestisce Mailgun, aspetta Stripe; MKX non c'è", async () => {
    as("p-laura");
    const rows = await vault.listCredentials({ projectId: "prj-acq" });
    expect(rows.map((r) => [r.service, r.access])).toEqual([
      ["Aruba hosting", "reads"],
      ["Cloudflare", "reads"],
      ["Mailgun", "manages"],
      ["Stripe", "waiting"],
    ]);
    expect((await vault.listCredentials({})).map((r) => r.id)).not.toContain(FIGMA);
  });

  it("una vista non porta MAI la password", async () => {
    as("p-roberta");
    const all = await vault.listCredentials({});
    expect(all).toHaveLength(5);
    expect(JSON.stringify(all)).not.toMatch(/Kx4!pa|Gq7#v2|mg-Tr9|sk-Wd2|Fg5&k1/);
  });

  it("Sara (Contributor) vede solo Cloudflare, che legge; Marco (chiave in attesa) aspetta Aruba", async () => {
    as("p-sara");
    expect((await vault.listCredentials({})).map((r) => [r.id, r.access])).toEqual([
      [CLOUDFLARE, "reads"],
    ]);
    as("p-marco");
    expect((await vault.listCredentials({})).map((r) => [r.id, r.access])).toEqual([
      [ARUBA, "waiting"],
    ]);
  });
});

describe("la barra e il Mac", () => {
  it("gli stati: Laura chiusa col Touch ID, Giulia da associare, Marco in attesa, Federico senza chiave", async () => {
    as("p-laura");
    expect(await vault.getVaultStatus()).toMatchObject({
      state: "locked",
      touchId: true,
      macFingerprint: "91be 4c07 2a3f d6e5",
    });
    as("p-giulia");
    expect((await vault.getVaultStatus()).state).toBe("unpaired");
    as("p-marco");
    expect(await vault.getVaultStatus()).toMatchObject({
      state: "key_pending",
      ownFingerprint: "7d20 e5a9 c31f 6b84",
    });
    as("p-federico");
    expect((await vault.getVaultStatus()).state).toBe("no_key");
  });

  it("aprire col Touch ID; annullato non apre; senza Touch ID si apre dal browser (D-1a)", async () => {
    as("p-laura");
    await vault.setVaultSimulation({ touchId: "cancelled" });
    expect(await vault.unlock()).toEqual({ ok: false, code: "touch_id_cancelled" });
    await vault.setVaultSimulation({ touchId: "unavailable" });
    expect((await vault.getVaultStatus()).touchId).toBe(false);
    expect(await vault.unlock()).toEqual({ ok: false, code: "touch_id_unavailable" });
    await vault.setVaultSimulation({ touchId: "works" });
    expect(await vault.unlock()).toEqual({ ok: true });
    expect((await vault.getVaultStatus()).state).toBe("open");
  });

  it("D-5: un sigillo revocato lascia il login, la barra dice `revoked`; irraggiungibile dice `unreachable` e non cancella", async () => {
    as("p-laura");
    await vault.setVaultSimulation({ opening: "unreachable" });
    expect(await vault.unlock()).toEqual({ ok: false, code: "unavailable" });
    expect((await vault.getVaultStatus()).state).toBe("unreachable");
    await vault.setVaultSimulation({ opening: "revoked" });
    expect(await vault.unlock()).toEqual({ ok: false, code: "revoked" });
    expect((await vault.getVaultStatus()).state).toBe("revoked");
    expect(state.vault.macs.some((m) => m.id === VAULT_IDS.LAURA_MAC)).toBe(false);
  });

  it("associare: l'impronta da confrontare, il ritorno dal browser apre senza tocco (D-1b), poi il tocco torna", async () => {
    as("p-giulia");
    const started = await vault.startPairing();
    expect(started).toMatchObject({ ok: true });
    const fp = (started as { fingerprint: string }).fingerprint;
    expect(fp).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect((await vault.getVaultStatus()).pairing?.fingerprint).toBe(fp);
    await vault.setVaultSimulation({ touchId: "cancelled" });
    expect(await vault.finishPairing("ok")).toEqual({ ok: true });
    expect((await vault.getVaultStatus()).state).toBe("open");
    await vault.lock();
    expect(await vault.unlock()).toEqual({ ok: false, code: "touch_id_cancelled" });
    expect((await vault.listMyMacs()).map((m) => [m.fingerprint, m.current])).toEqual([[fp, true]]);
  });

  it("un'associazione scaduta o che non corrisponde non lascia niente", async () => {
    as("p-giulia");
    await vault.startPairing();
    expect(await vault.finishPairing("mismatch")).toEqual({ ok: false, code: "open_failed" });
    expect(await vault.listMyMacs()).toEqual([]);
    expect((await vault.getVaultStatus()).state).toBe("unpaired");
  });

  it("senza chiave confermata non si associa", async () => {
    as("p-marco");
    expect(await vault.startPairing()).toEqual({ ok: false, code: "vault_key_not_confirmed" });
  });
});

describe("mostrare e copiare", () => {
  it("chiusa: `vault_locked`; aperta: Show dà la password e il registro dice «shown» dal Mac", async () => {
    as("p-laura");
    expect(await vault.show(ARUBA)).toEqual({ ok: false, code: "vault_locked" });
    await vault.unlock();
    expect(await vault.show(ARUBA)).toEqual({ ok: true, password: "Kx4!pa-77Wq" });
    expect(state.vault.log.at(-1)).toMatchObject({
      credentialId: ARUBA,
      personId: "p-laura",
      action: "shown",
      via: "mac",
    });
  });

  it("Copy scrive gli appunti dal livello dati e NON restituisce la password; si legge solo ciò che si legge", async () => {
    as("p-laura");
    await vault.unlock();
    const out = await vault.copy(CLOUDFLARE);
    expect(out).toEqual({ ok: true });
    expect(clip).toBe("Gq7#v2-LmpZ");
    expect(state.vault.log.at(-1)).toMatchObject({ action: "copied", via: "mac" });
    // Mailgun la gestisce, non la legge; Stripe aspetta la copia.
    expect(await vault.show(MAILGUN)).toEqual({ ok: false, code: "not_found" });
    expect(await vault.show(STRIPE)).toEqual({ ok: false, code: "waiting" });
  });
});

describe("accessi da confermare", () => {
  it("Laura conferma Marco: la persona, l'impronta e Aruba; poi Marco legge Aruba", async () => {
    as("p-laura");
    const pending = await vault.listPending();
    expect(pending.map((p) => [p.personId, p.fingerprint, p.credentials.map((c) => c.id)])).toEqual(
      [["p-marco", "7d20 e5a9 c31f 6b84", [ARUBA]]],
    );
    // Review M7: senza un Mac associato niente tocco: `vault_locked`.
    await vault.forgetThisMac();
    expect(await vault.confirm(pending[0]!.keyId)).toEqual({ ok: false, code: "vault_locked" });
    resetApi();
    as("p-laura");
    expect(await vault.confirm(pending[0]!.keyId)).toEqual({
      ok: true,
      saved: 1,
      keyChanged: 0,
      notAllowed: 0,
      unopenable: 0,
    });
    as("p-marco");
    expect((await vault.listCredentials({})).map((r) => [r.id, r.access])).toEqual([
      [ARUBA, "reads"],
    ]);
  });

  it("Matteo passa a Laura la copia di Stripe; rifiutare toglie la chiave", async () => {
    as("p-matteo");
    const pending = await vault.listPending();
    expect(pending.find((p) => p.personId === "p-laura")!.credentials.map((c) => c.id)).toEqual([
      STRIPE,
    ]);
    state.vault.thisMac.set("p-matteo", {
      macId: "mac-matteo-mba",
      open: true,
      freshlyPaired: false,
      revoked: false,
      pairing: null,
      unreachable: false,
    });
    const marco = pending.find((p) => p.personId === "p-marco");
    expect(marco).toBeUndefined(); // Matteo non legge Aruba: non può passarla
    expect(await vault.reject(pending.find((p) => p.personId === "p-laura")!.keyId)).toEqual({
      ok: true,
    });
    expect(state.vault.keys.some((k) => k.personId === "p-laura")).toBe(false);
  });
});

describe("i lettori", () => {
  it("lettori diretti ed effettivi con la fonte e lo stato", async () => {
    as("p-laura");
    const r = await vault.listReaders(ARUBA);
    expect(r.canShare).toBe(true);
    expect(r.direct.map((d) => [d.kind, d.id])).toEqual([["role", "role-developer"]]);
    const byId = Object.fromEntries(r.effective.map((e) => [e.personId, [e.source, e.state]]));
    expect(byId["p-laura"]).toEqual(["created", "reads"]);
    expect(byId["p-roberta"]).toEqual(["full_admin", "reads"]);
    expect(byId["p-marco"]).toEqual(["role", "key_pending"]);
    expect(byId["p-federico"]).toEqual(["role", "no_key"]);
  });

  // Review M7: condividere fa il SUO Touch ID (anche a cassaforte chiusa,
  // che resta chiusa); un tocco annullato non condivide.
  it("condividere chiede il suo Touch ID; con una chiave confermata la persona legge subito", async () => {
    as("p-laura");
    await vault.setVaultSimulation({ touchId: "cancelled" });
    expect(await vault.share(ARUBA, { personId: "p-sara" })).toEqual({
      ok: false,
      code: "touch_id_cancelled",
    });
    await vault.setVaultSimulation({ touchId: "works" });
    expect(await vault.share(ARUBA, { personId: "p-sara" })).toEqual({ ok: true, waiting: [] });
    expect((await vault.getVaultStatus()).state).toBe("locked");
    as("p-sara");
    expect((await vault.listCredentials({})).map((r) => r.id)).toContain(ARUBA);
  });

  it("togliere un lettore: chi non legge più perde la copia", async () => {
    as("p-laura");
    await vault.unlock();
    const r = await vault.listReaders(CLOUDFLARE);
    expect(await vault.removeReader(CLOUDFLARE, r.direct[0]!.readerId)).toEqual({ ok: true });
    as("p-sara");
    expect(await vault.listCredentials({})).toEqual([]);
    expect(state.vault.keys.find((k) => k.personId === "p-sara")!.copies).not.toContain(CLOUDFLARE);
  });
});

describe("i Mac", () => {
  it("Laura vede i suoi due Mac, questo per primo; togliere l'altro vuole la riconferma E la cassaforte aperta (VA-Q4, e5b85be0e)", async () => {
    as("p-laura");
    expect((await vault.listMyMacs()).map((m) => [m.name, m.current])).toEqual([
      ["MacBook Pro di Laura", true],
      ["iMac in ufficio", false],
    ]);
    expect(await vault.removeMac("mac-laura-imac")).toEqual({ ok: false, code: "reauth_required" });
    markReauthenticated("p-laura");
    expect(await vault.removeMac("mac-laura-imac")).toEqual({ ok: false, code: "vault_locked" });
    await vault.unlock();
    expect(await vault.removeMac("mac-laura-imac")).toEqual({ ok: true });
    expect((await vault.listMyMacs()).map((m) => m.name)).toEqual(["MacBook Pro di Laura"]);
    // Questo Mac non si toglie da qui: «Dimentica questo Mac».
    expect(await vault.removeMac(VAULT_IDS.LAURA_MAC)).toEqual({ ok: false, code: "use_mine" });
    // Il Mac di un altro: come se non ci fosse.
    expect(await vault.removeMac("mac-matteo-mba")).toEqual({ ok: false, code: "not_found" });
  });

  it("«Dimentica questo Mac»: il login resta, la barra torna da associare", async () => {
    as("p-laura");
    await vault.unlock();
    expect(await vault.forgetThisMac()).toEqual({ ok: true, remote: true });
    expect((await vault.getVaultStatus()).state).toBe("unpaired");
  });

  it("l'admin vede e toglie i Mac di un'altra persona, con la riconferma", async () => {
    as("p-laura");
    expect(await vault.listMacsOf("p-matteo")).toEqual({ ok: false, code: "forbidden" });
    as("p-roberta");
    const res = await vault.listMacsOf("p-laura");
    expect(res).toMatchObject({ ok: true });
    expect(await vault.removeMacOf("p-laura", "mac-laura-imac")).toEqual({
      ok: false,
      code: "reauth_required",
    });
    markReauthenticated("p-roberta");
    expect(await vault.removeMacOf("p-laura", "mac-laura-imac")).toEqual({ ok: true });
  });
});

describe("nuova e modifica", () => {
  it("chi ha `credentials.create` crea; chi la crea la legge (chiave confermata); cambiare la password vuole la cassaforte aperta", async () => {
    as("p-laura");
    const made = await vault.createCredential("prj-acq", {
      service: "Sentry",
      label: null,
      url: null,
      username: "ops",
      notes: null,
      password: "s3ntry!",
    });
    expect(made).toMatchObject({ ok: true });
    const id = (made as { id: string }).id;
    expect(
      (await vault.listCredentials({ projectId: "prj-acq" })).find((r) => r.id === id)!.access,
    ).toBe("reads");
    expect(await vault.updateCredential(id, { password: "new-one" })).toEqual({
      ok: false,
      code: "vault_locked",
    });
    expect(await vault.updateCredential(id, { username: "ops2" })).toEqual({ ok: true });
    as("p-sara");
    expect(
      await vault.createCredential("prj-acq", {
        service: "X",
        label: null,
        url: null,
        username: null,
        notes: null,
        password: "x",
      }),
    ).toEqual({ ok: false, code: "forbidden" });
  });
});

describe("il registro", () => {
  it("chi gestisce lo legge, con «from the Mac» / «from the browser» (VA-Q5); chi legge e basta no", async () => {
    as("p-laura");
    const log = await vault.listAccessLog({ projectId: "prj-acq" });
    expect(log.map((e) => [e.service, e.action, e.via])).toEqual([
      ["Aruba hosting", "shown", "mac"],
      ["Cloudflare", "copied", "browser"],
      ["Mailgun", "copied", "mac"],
    ]);
    as("p-sara");
    expect(await vault.listAccessLog({ projectId: "prj-acq" })).toEqual([]);
  });
});
