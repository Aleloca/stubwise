#!/usr/bin/env node
// Compila l'helper Swift del Secure Enclave (`native/keyhelper/main.swift`,
// revisione di sicurezza della cassaforte, I1) in un binario universale
// (arm64 + x86_64) in `build/bin/stubwise-keyhelper`, che electron-builder
// mette accanto all'eseguibile e firma con l'app. Serve `swiftc` (Xcode o le
// Command Line Tools); dipende solo dai framework di sistema.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native/keyhelper/main.swift");
const outDir = join(root, "build/bin");
const out = join(outDir, "stubwise-keyhelper");
mkdirSync(outDir, { recursive: true });

// M5/I2: l'identifier che il requisito di firma del main nomina. Un binario
// senza Info.plist prende il nome del file (e in ad-hoc un hash in coda), e
// electron-builder non passa `--identifier` quando rifirma: un Info.plist
// incorporato nel binario fissa `stubwise-keyhelper` in ogni firma.
// check-signature controlla che sia rimasto questo.
const HELPER_IDENTIFIER = "stubwise-keyhelper";
const plist = join(outDir, "keyhelper-Info.plist");
writeFileSync(
  plist,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${HELPER_IDENTIFIER}</string>
<key>CFBundleName</key><string>${HELPER_IDENTIFIER}</string>
</dict></plist>
`,
);
const embedPlist = [
  "-Xlinker",
  "-sectcreate",
  "-Xlinker",
  "__TEXT",
  "-Xlinker",
  "__info_plist",
  "-Xlinker",
  plist,
];

const slices = ["arm64", "x86_64"].map((arch) => {
  const slice = `${out}-${arch}`;
  execFileSync(
    "swiftc",
    [
      "-O",
      "-swift-version",
      "5",
      "-target",
      `${arch}-apple-macos13`,
      source,
      "-o",
      slice,
      ...embedPlist,
    ],
    { stdio: "inherit" },
  );
  return slice;
});
execFileSync("lipo", ["-create", ...slices, "-output", out], { stdio: "inherit" });
for (const slice of slices) rmSync(slice, { force: true });
// Firmata ad-hoc qui (lipo toglie la firma del linker); electron-builder la rifirma.
execFileSync("codesign", ["--force", "--sign", "-", out], { stdio: "inherit" });
console.log(`build-keyhelper: ${out}`);
