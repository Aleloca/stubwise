#!/usr/bin/env node
// Compila l'helper Swift del Secure Enclave (`native/keyhelper/main.swift`,
// revisione di sicurezza della cassaforte, I1) in un binario universale
// (arm64 + x86_64) in `build/bin/stubwise-keyhelper`, che electron-builder
// mette accanto all'eseguibile e firma con l'app. Serve `swiftc` (Xcode o le
// Command Line Tools); dipende solo dai framework di sistema.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "native/keyhelper/main.swift");
const outDir = join(root, "build/bin");
const out = join(outDir, "stubwise-keyhelper");
mkdirSync(outDir, { recursive: true });

const slices = ["arm64", "x86_64"].map((arch) => {
  const slice = `${out}-${arch}`;
  execFileSync(
    "swiftc",
    ["-O", "-swift-version", "5", "-target", `${arch}-apple-macos13`, source, "-o", slice],
    { stdio: "inherit" },
  );
  return slice;
});
execFileSync("lipo", ["-create", ...slices, "-output", out], { stdio: "inherit" });
for (const slice of slices) rmSync(slice, { force: true });
console.log(`build-keyhelper: ${out}`);
