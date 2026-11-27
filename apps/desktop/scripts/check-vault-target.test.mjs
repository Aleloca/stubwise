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
  it("web: il ponte del desktop fa fallire (anche minificato)", () => {
    expect(violations(bundle("const b=window.stubwise?.vault;"), "web")).toHaveLength(1);
    expect(violations(bundle('throw new Error("vault_bridge_missing")'), "web")).toHaveLength(1);
    expect(violations(bundle("fetch('/api/credentials')"), "web")).toEqual([]);
  });

  it("electron: la PRF e il canale fra le schede fanno fallire; le passkey della riconferma no", () => {
    expect(violations(bundle("{extensions:{prf:{eval:{first:x}}}}"), "electron")).toHaveLength(1);
    expect(violations(bundle('new BroadcastChannel("stubwise-vault")'), "electron")).toHaveLength(1);
    expect(violations(bundle("navigator.credentials.get(o)"), "electron")).toEqual([]);
  });
});
