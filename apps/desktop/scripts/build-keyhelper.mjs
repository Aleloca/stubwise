#!/usr/bin/env node
// Compila l'helper Swift del Secure Enclave (`native/keyhelper/main.swift`,
// revisione di sicurezza della cassaforte, I1) in un binario universale
// (arm64 + x86_64) dentro il bundle `build/bin/StubwiseKeyHelper.app`, che
// electron-builder mette in `Contents/Helpers/` SENZA rifirmarlo
// (`signIgnore`). Serve `swiftc` (Xcode o le Command Line Tools).
//
// Seconda revisione, I1: la chiave è una voce del Keychain di data
// protection con l'access group del team, e quell'entitlement è riservato:
// vuole un profilo di provisioning Developer ID incorporato nel bundle.
// - `--sign` (il pacchetto firmato): profilo da `STUBWISE_KEYHELPER_PROFILE`
//   (un percorso FUORI dalla repo), Team ID da `STUBWISE_TEAM_ID`, identità
//   da `CSC_NAME` (o la «Developer ID Application» del portachiavi); firma con
//   hardened runtime, timestamp e gli entitlements di `keyhelper-bundle.mjs`.
// - senza (il pacchetto locale): firma ad-hoc, nessun entitlement (senza
//   profilo un entitlement riservato farebbe uccidere l'helper dal sistema);
//   l'helper risponde `unsigned` e la cassaforte dal desktop resta spenta.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { helperEntitlements, helperInfoPlist, identity } from "./keyhelper-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native/keyhelper/main.swift");
const outDir = join(root, "build/bin");
const bundle = join(outDir, `${identity.bundleName}.app`);
const contents = join(bundle, "Contents");
const out = join(contents, "MacOS", identity.executable);
const sign = process.argv.includes("--sign");

const fail = (message) => {
  console.error(`build-keyhelper: ${message}`);
  process.exit(1);
};
const teamId = process.env["STUBWISE_TEAM_ID"] ?? "";
const profile = process.env["STUBWISE_KEYHELPER_PROFILE"] ?? "";
if (sign) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) fail("STUBWISE_TEAM_ID mancante o non valido");
  if (!profile || !existsSync(profile)) fail("STUBWISE_KEYHELPER_PROFILE: il profilo non c'è");
}

rmSync(bundle, { recursive: true, force: true });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(join(contents, "Info.plist"), helperInfoPlist());

const slices = ["arm64", "x86_64"].map((arch) => {
  const slice = join(outDir, `${identity.executable}-${arch}`);
  execFileSync(
    "swiftc",
    ["-O", "-swift-version", "5", "-target", `${arch}-apple-macos13`, source, "-o", slice],
    { stdio: "inherit" },
  );
  return slice;
});
execFileSync("lipo", ["-create", ...slices, "-output", out], { stdio: "inherit" });
for (const slice of slices) rmSync(slice, { force: true });

if (sign) {
  copyFileSync(profile, join(contents, "embedded.provisionprofile"));
  const entitlements = join(outDir, "keyhelper.entitlements.plist");
  writeFileSync(entitlements, helperEntitlements(teamId));
  const id = process.env["CSC_NAME"] || "Developer ID Application";
  execFileSync(
    "codesign",
    [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      entitlements,
      "--sign",
      id,
      bundle,
    ],
    { stdio: "inherit" },
  );
} else {
  execFileSync("codesign", ["--force", "--sign", "-", bundle], { stdio: "inherit" });
}
console.log(`build-keyhelper: ${bundle}${sign ? " (firmato col team)" : " (ad-hoc)"}`);
