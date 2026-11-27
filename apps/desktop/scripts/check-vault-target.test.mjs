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
});
