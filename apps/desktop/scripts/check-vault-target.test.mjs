// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { violations } from "./check-vault-target.mjs";

// Cassaforte nel browser, design §4: ogni build porta solo la sua cassaforte.

let dir;
const bundle = (text) => {
  dir = mkdtempSync(join(tmpdir(), "vault-target-"));
  writeFileSync(join(dir, "index-abc.js"), text);
  return dir;
};
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("check-vault-target", () => {
  it("web: senza il file del worker, o con la crittografia dello sblocco nella pagina, fallisce", () => {
    const d = bundle('const c=new BroadcastChannel("stubwise-vault");const w="stubwise-vault-worker";');
    expect(violations(d, "web").map((v) => v.why)).toContain("manca il file del worker della cassaforte");
    writeFileSync(join(d, "worker-abc.js"), "AES-GCM");
    expect(violations(d, "web")).toEqual([]);
    writeFileSync(join(d, "index-abc.js"), 'importKey("pkcs8",x);new BroadcastChannel("stubwise-vault");"stubwise-vault-worker"');
    expect(violations(d, "web").map((v) => v.why)).toContain("la crittografia dello sblocco fuori dal worker");
  });

  it("web: il ponte del desktop fa fallire (anche minificato)", () => {
    const forbidden = (text) => violations(bundle(text), "web").filter((v) => !v.why.startsWith("manca"));
    expect(forbidden("const b=window.stubwise?.vault;")).toHaveLength(1);
    expect(forbidden('throw new Error("vault_bridge_missing")')).toHaveLength(1);
    expect(forbidden("fetch('/api/credentials')")).toEqual([]);
  });

  it("electron: la PRF e il canale fra le schede fanno fallire; le passkey della riconferma no", () => {
    const forbidden = (text) => violations(bundle(text), "electron").filter((v) => !v.why.startsWith("manca"));
    expect(forbidden("{extensions:{prf:{eval:{first:x}}}}")).toHaveLength(1);
    expect(forbidden('new BroadcastChannel("stubwise-vault")')).toHaveLength(1);
    expect(forbidden("navigator.credentials.get(o)")).toEqual([]);
    // M-6: i moduli della cassaforte del desktop DEVONO esserci.
    expect(violations(bundle("x"), "electron").map((v) => v.why)).toContain("manca i moduli della cassaforte del desktop");
  });

  it("m-5: electron, i marcatori della fase 2 (recupero, associazione, sigilli) fanno fallire", () => {
    const forbidden = (text) => violations(bundle(text), "electron").filter((v) => !v.why.startsWith("manca"));
    for (const text of [
      'fetch("/api/vault/recovery/challenge")',
      'fetch("/api/vault/device-pairings/lookup")',
      'fetch("/api/vault/recovery-key/preview")',
      '{t:"recoveryLoad",kitText:k}',
      '{t:"sealBegin"}',
      '{t:"pairSeal"}',
    ])
      expect(forbidden(text), text).not.toEqual([]);
    // Il main chiede l'associazione (`device-pairings`, senza `lookup`): resta lecito.
    expect(forbidden('fetch("/api/vault/device-pairings")')).toEqual([]);
  });

  it("I-2: vault, la pagina a sé: il worker a sé e nessun pezzo dell'app né il ponte del desktop", () => {
    const d = bundle('const c=new BroadcastChannel("stubwise-vault");const w="stubwise-vault-worker";');
    expect(violations(d, "vault").map((v) => v.why)).toContain("manca il file del worker della cassaforte");
    writeFileSync(join(d, "worker-abc.js"), "AES-GCM");
    expect(violations(d, "vault")).toEqual([]);
    const forbidden = (text) => {
      writeFileSync(join(d, "index-abc.js"), `${text};new BroadcastChannel("stubwise-vault");"stubwise-vault-worker"`);
      return violations(d, "vault").map((v) => v.why);
    };
    for (const text of ['fetch("/api/chat/x")', 'fetch("/api/claude/x")', 'fetch("/api/settings/x")', 'fetch("/api/admin/x")', 'createPolicy("stubwise-html",p)', "window.stubwise?.vault"])
      expect(forbidden(text), text).not.toEqual([]);
    expect(forbidden('fetch("/api/auth/me")')).toEqual([]);
    expect(forbidden('importKey("pkcs8",x)')).toContain("la crittografia dello sblocco fuori dal worker");
  });

  it("m-3 (seconda revisione): vault, le rotte /api/ in elenco chiuso; la pagina ne ha due, il worker le sue", () => {
    const d = bundle('fetch("/api/auth/me");fetch("/api/me/security");new BroadcastChannel("stubwise-vault");"stubwise-vault-worker"');
    writeFileSync(join(d, "worker-abc.js"), 'fetch("/api/vault/status");fetch(`/api/credentials/${id}/reveal`);fetch("/api/me/security/reauth/passkey/verify")');
    expect(violations(d, "vault")).toEqual([]);
    // Una rotta fuori elenco, nella pagina o nel worker.
    writeFileSync(join(d, "worker-abc.js"), 'fetch("/api/vault/status");fetch("/api/tasks/x")');
    expect(violations(d, "vault").map((v) => v.why).join()).toContain("/api/tasks/x");
    writeFileSync(join(d, "worker-abc.js"), 'fetch("/api/vault/status")');
    writeFileSync(join(d, "index-abc.js"), 'fetch("/api/vault/status");new BroadcastChannel("stubwise-vault");"stubwise-vault-worker"');
    expect(violations(d, "vault").map((v) => v.why).join()).toContain("/api/vault/status");
  });
});

