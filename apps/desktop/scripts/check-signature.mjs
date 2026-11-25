#!/usr/bin/env node
// Verifica la firma dell'app impacchettata (seconda revisione di sicurezza
// della cassaforte, M5), dopo electron-builder e dopo check-fuses:
// - `codesign --verify --deep --strict` sull'app (firma integra e completa);
// - pacchetto firmato: hardened runtime (`flags=…runtime`) e Team ID
//   (`STUBWISE_TEAM_ID`) su app E helper, e l'identifier dell'helper
//   (`stubwise-keyhelper`), che il requisito di I2 nomina: un helper con un
//   altro identifier non passerebbe la verifica del main, e la cassaforte dal
//   desktop sarebbe spenta senza dirlo.
// - `--adhoc` (il pacchetto locale): solo la firma integra, che basta perché
//   macOS lo lasci partire.
// Uso: `node scripts/check-signature.mjs release [--adhoc]`.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { identity } from "./keyhelper-bundle.mjs";

export const HELPER_IDENTIFIER = identity.bundleId;

/** Le violazioni nell'uscita di `codesign -dv` (vuoto = a posto). */
export function signatureProblems(text, want) {
  const field = (name) => new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const problems = [];
  const flags = /^CodeDirectory .*flags=(\S+)/m.exec(text)?.[1] ?? "";
  if (!/\bruntime\b/.test(flags)) problems.push("senza hardened runtime");
  const team = field("TeamIdentifier");
  if (team !== want.teamId) problems.push(`Team ID ${team || "assente"}, atteso ${want.teamId}`);
  if (want.identifier) {
    const id = field("Identifier");
    if (id !== want.identifier) problems.push(`identifier ${id}, atteso ${want.identifier}`);
  }
  return problems;
}

/** Le violazioni negli entitlements dell'helper (`codesign -d --entitlements - --xml`). */
export function entitlementProblems(xml, want) {
  const group = `${want.teamId}.${identity.accessGroupSuffix}`;
  const problems = [];
  if (!xml.includes(`<string>${group}</string>`))
    problems.push(`manca il gruppo del Keychain ${group}`);
  return problems;
}

function codesign(args) {
  try {
    return execFileSync("codesign", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`codesign ${args.join(" ")}: ${error.stderr || error.message}`);
  }
}

/** `codesign -dv` scrive su stderr: lo si legge girandolo su stdout. */
function describe(path) {
  return execFileSync("sh", ["-c", 'codesign -dv --verbose=2 "$0" 2>&1', path], {
    encoding: "utf8",
  });
}

function main() {
  const out = process.argv[2] ?? "release";
  const adhoc = process.argv.includes("--adhoc");
  const apps = readdirSync(out)
    .filter((d) => d.startsWith("mac"))
    .map((d) => join(out, d, "Stubwise.app"))
    .filter((p) => existsSync(p));
  if (apps.length === 0) {
    console.error(`check-signature: nessuna app in ${out}/mac*/Stubwise.app`);
    process.exit(1);
  }
  const teamId = process.env["STUBWISE_TEAM_ID"] ?? "";
  if (!adhoc && !/^[A-Z0-9]{10}$/.test(teamId)) {
    console.error("check-signature: STUBWISE_TEAM_ID mancante o non valido (10 caratteri)");
    process.exit(1);
  }
  let failed = false;
  for (const app of apps) {
    try {
      codesign(["--verify", "--deep", "--strict", app]);
    } catch (error) {
      console.error(`check-signature: ${error.message}`);
      failed = true;
      continue;
    }
    if (adhoc) continue;
    const helperBundle = join(app, "Contents", "Helpers", `${identity.bundleName}.app`);
    const helper = helperBundle;
    if (!existsSync(join(helperBundle, "Contents", "embedded.provisionprofile"))) {
      console.error(`check-signature: ${helperBundle}: manca embedded.provisionprofile`);
      failed = true;
    }
    for (const problem of entitlementProblems(
      execFileSync(
        "sh",
        ["-c", 'codesign -d --entitlements - --xml "$0" 2>/dev/null', helperBundle],
        {
          encoding: "utf8",
        },
      ),
      { teamId },
    )) {
      console.error(`check-signature: ${helperBundle}: ${problem}`);
      failed = true;
    }
    for (const [path, want] of [
      [app, { teamId }],
      [helper, { teamId, identifier: HELPER_IDENTIFIER }],
    ]) {
      for (const problem of signatureProblems(describe(path), want)) {
        console.error(`check-signature: ${path}: ${problem}`);
        failed = true;
      }
    }
  }
  if (failed) process.exit(1);
  console.log(`check-signature: ok (${apps.length} app${adhoc ? ", ad-hoc" : ""})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
