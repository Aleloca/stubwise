// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- uno script .mjs senza tipi
import { entitlementProblems, signatureProblems } from "../../scripts/check-signature.mjs";
// @ts-expect-error -- uno script .mjs senza tipi
import { helperEntitlements, helperInfoPlist } from "../../scripts/keyhelper-bundle.mjs";
import identity from "../../native/keyhelper/identity.json";
import { HELPER_IDENTIFIER } from "./keyHelper";

// Revisione di sicurezza della cassaforte, I1 (piano approvato da 46, 25 nov
// 2026): l'app si firma con hardened runtime ed entitlements minimi, le fuse
// chiudono le porte da cui un programma dello stesso utente leggerebbe la
// chiave del Mac (RunAsNode, NODE_OPTIONS, --inspect, un app.asar
// sostituito), e la firma e la notarizzazione prendono le credenziali SOLO
// da env o dal portachiavi. Il build locale non firmato esiste ancora, con
// la cassaforte dal desktop spenta.

const root = resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");
const builder = read("electron-builder.yml");
const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

describe("il pacchetto del Mac", () => {
  it("le fuse: RunAsNode, NODE_OPTIONS e --inspect spenti; integrità dell'asar e solo dall'asar accese", () => {
    const fuses = builder.slice(builder.indexOf("electronFuses:"));
    expect(fuses).toMatch(/runAsNode: false/);
    expect(fuses).toMatch(/enableNodeOptionsEnvironmentVariable: false/);
    expect(fuses).toMatch(/enableNodeCliInspectArguments: false/);
    expect(fuses).toMatch(/enableEmbeddedAsarIntegrityValidation: true/);
    expect(fuses).toMatch(/onlyLoadAppFromAsar: true/);
    // M5 (seconda revisione), col renderer su app://: file:// senza privilegi
    // in più, e i cookie cifrati.
    expect(fuses).toMatch(/grantFileProtocolExtraPrivileges: false/);
    expect(fuses).toMatch(/enableCookieEncryption: true/);
    const check = read("scripts/check-fuses.mjs");
    expect(check).toMatch(
      /\[FuseV1Options\.GrantFileProtocolExtraPrivileges\]: FuseState\.DISABLE/,
    );
    expect(check).toMatch(/\[FuseV1Options\.EnableCookieEncryption\]: FuseState\.ENABLE/);
    expect(builder).toMatch(/asar: true/);
  });

  it("hardened runtime con entitlements minimi: solo allow-jit, niente che allarghi il runtime", () => {
    expect(builder).toMatch(/hardenedRuntime: true/);
    expect(builder).toMatch(/entitlements: build\/entitlements\.mac\.plist/);
    expect(builder).toMatch(/entitlementsInherit: build\/entitlements\.mac\.plist/);
    const plist = read("build/entitlements.mac.plist");
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    expect(keys).toEqual(["com.apple.security.cs.allow-jit"]);
  });

  it("nessuna credenziale nella repo: identità e notarizzazione da env o dal portachiavi", () => {
    expect(builder).not.toMatch(/identity:\s*["']?[A-Z0-9]{10}/);
    expect(builder).not.toMatch(/APPLE_(API_KEY|ID|APP_SPECIFIC_PASSWORD)\s*[:=]/);
    // Un percorso di chiave (`AuthKey_X.p8`, `keys/…p8`), non la parola nel commento.
    expect(builder).not.toMatch(/[A-Za-z0-9_/-]+\.p8\b/);
    const ignore = read("../../.gitignore");
    expect(ignore).toMatch(/\*\.p8/);
    // Il profilo dell'helper (I1, seconda revisione) arriva da env.
    expect(ignore).toMatch(/\*\.provisionprofile/);
    expect(read("scripts/build-keyhelper.mjs")).toMatch(
      /process\.env\["STUBWISE_KEYHELPER_PROFILE"\]/,
    );
  });

  it("due pacchetti: il firmato (cassaforte dal desktop accesa, fuse rilette) e il locale (spenta)", () => {
    expect(scripts["package:mac"]).toMatch(/STUBWISE_VAULT_DESKTOP=on/);
    expect(scripts["package:mac"]).toMatch(/--config\.mac\.notarize=true/);
    expect(scripts["package:mac"]).toMatch(/node scripts\/check-fuses\.mjs/);
    expect(scripts["package:mac:unsigned"]).toMatch(/CSC_IDENTITY_AUTO_DISCOVERY=false/);
    expect(scripts["package:mac:unsigned"]).not.toMatch(/STUBWISE_VAULT_DESKTOP=on/);
    expect(scripts["package:mac:unsigned"]).toMatch(/node scripts\/check-fuses\.mjs/);
    expect(existsSync(resolve(root, "scripts/check-fuses.mjs"))).toBe(true);
    // Una regola sola per il seme (72, fd12ed443): il controllo su tutto `out/`.
    for (const name of ["package:mac", "package:mac:unsigned"])
      expect(scripts[name], name).toMatch(/pnpm check:seed:app && /);
    expect(scripts["check:seed:app"]).toMatch(/check-no-seed\.mjs out$/);
  });

  it("l'helper del Secure Enclave si compila prima del pacchetto, come bundle in Contents/Helpers", () => {
    // Il firmato lo firma lo script (entitlements e profilo), il locale ad-hoc.
    expect(scripts["package:mac"]).toMatch(/^node scripts\/build-keyhelper\.mjs --sign && /);
    expect(scripts["package:mac:unsigned"]).toMatch(/^node scripts\/build-keyhelper\.mjs && /);
    expect(builder).toMatch(
      /from: build\/bin\/StubwiseKeyHelper\.app\s+to: Helpers\/StubwiseKeyHelper\.app/,
    );
    // electron-builder non lo rifirma: perderebbe entitlements e profilo.
    expect(builder).toContain('signIgnore:\n    - "StubwiseKeyHelper\\\\.app"');
    expect(existsSync(resolve(root, "scripts/build-keyhelper.mjs"))).toBe(true);
    expect(existsSync(resolve(root, "native/keyhelper/main.swift"))).toBe(true);
  });

  // M5 (seconda revisione di sicurezza): dopo il pacchetto firmato si
  // verificano la firma (`codesign --verify --deep --strict`), l'hardened
  // runtime e il Team ID su app E helper, e l'identifier dell'helper (il
  // requisito di I2 lo nomina). Il pacchetto locale si firma ad-hoc, senza
  // hardened runtime: senza una firma valida macOS lo uccide all'avvio.
  it("M5: il firmato verifica la firma dopo il pacchetto; il locale si firma ad-hoc", () => {
    expect(scripts["package:mac"]).toMatch(/&& node scripts\/check-signature\.mjs release$/);
    expect(scripts["package:mac:unsigned"]).toMatch(
      /--config\.mac\.identity=- --config\.mac\.hardenedRuntime=false/,
    );
    expect(scripts["package:mac:unsigned"]).toMatch(
      /node scripts\/check-signature\.mjs release --adhoc$/,
    );
  });

  it("I1: un'identità sola dell'helper — main, script e Swift dicono la stessa", () => {
    expect(HELPER_IDENTIFIER).toBe(identity.bundleId);
    expect(read("native/keyhelper/main.swift")).toContain(`.${identity.accessGroupSuffix}`);
    // Il rinforzo del processo padre (46, 25 nov 2026): l'helper risponde solo
    // all'app firmata dal team, col SUO identifier — lo stesso del pacchetto.
    expect(builder).toMatch(
      new RegExp(`^appId: ${identity.appBundleId.replace(/\./g, "\\.")}$`, "m"),
    );
    expect(read("native/keyhelper/main.swift")).toContain(
      `identifier \\"${identity.appBundleId}\\"`,
    );
    const plist = helperInfoPlist();
    expect(plist).toContain(`<key>CFBundleIdentifier</key><string>${identity.bundleId}</string>`);
    expect(plist).toContain(`<key>CFBundleExecutable</key><string>${identity.executable}</string>`);
    expect(plist).toContain("<key>LSUIElement</key><true/>");
  });

  it("I1: gli entitlements dell'helper — application-identifier, team e il gruppo del Keychain", () => {
    const xml = helperEntitlements("ABCDE12345");
    expect(xml).toContain(
      `<key>com.apple.application-identifier</key><string>ABCDE12345.${identity.bundleId}</string>`,
    );
    expect(xml).toContain(
      "<key>com.apple.developer.team-identifier</key><string>ABCDE12345</string>",
    );
    expect(xml).toContain(
      `<key>keychain-access-groups</key><array><string>ABCDE12345.${identity.accessGroupSuffix}</string></array>`,
    );
    expect(() => helperEntitlements("")).toThrow();
    expect(entitlementProblems(xml, { teamId: "ABCDE12345" })).toEqual([]);
    expect(entitlementProblems("<plist/>", { teamId: "ABCDE12345" })).toEqual([
      `manca il gruppo del Keychain ABCDE12345.${identity.accessGroupSuffix}`,
    ]);
  });

  const info = (over: Partial<Record<"id" | "flags" | "team", string>> = {}) =>
    [
      `Identifier=${over.id ?? "dev.aleloca.stubwise.keyhelper"}`,
      `CodeDirectory v=20500 size=1 flags=${over.flags ?? "0x10000(runtime)"} hashes=1+0 location=embedded`,
      `TeamIdentifier=${over.team ?? "ABCDE12345"}`,
    ].join("\n");

  it("M5: le regole della firma — runtime, Team ID, identifier", () => {
    const want = { teamId: "ABCDE12345", identifier: "dev.aleloca.stubwise.keyhelper" };
    expect(signatureProblems(info(), want)).toEqual([]);
    expect(signatureProblems(info({ flags: "0x20002(adhoc,linker-signed)" }), want)).toEqual([
      "senza hardened runtime",
    ]);
    expect(signatureProblems(info({ team: "not set" }), want)).toEqual([
      "Team ID not set, atteso ABCDE12345",
    ]);
    expect(signatureProblems(info({ id: "stubwise-keyhelper-arm64" }), want)).toEqual([
      "identifier stubwise-keyhelper-arm64, atteso dev.aleloca.stubwise.keyhelper",
    ]);
    // L'app: identifier libero, runtime e team sì.
    expect(
      signatureProblems(info({ id: "dev.stubwise.desktop" }), { teamId: "ABCDE12345" }),
    ).toEqual([]);
  });
});
