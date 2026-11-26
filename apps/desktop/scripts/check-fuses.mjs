#!/usr/bin/env node
// Rilegge le fuse dal binario dell'app impacchettata (revisione di sicurezza
// della cassaforte, I1) e fallisce se una non è quella attesa: è la prova che
// `electronFuses` di electron-builder.yml è arrivata davvero nel pacchetto.
// Uso: `node scripts/check-fuses.mjs release` (dopo electron-builder).
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
// `@electron/fuses` è CommonJS (niente export con nome), e `FuseState` esiste
// solo nei suoi tipi: i valori sono quelli di `dist/constants.d.ts`.
import fuses from "@electron/fuses";

const { FuseV1Options, getCurrentFuseWire } = fuses;
const FuseState = { DISABLE: 48, ENABLE: 49 };

const EXPECTED = {
  [FuseV1Options.RunAsNode]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: FuseState.DISABLE,
  [FuseV1Options.EnableNodeCliInspectArguments]: FuseState.DISABLE,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: FuseState.ENABLE,
  [FuseV1Options.OnlyLoadAppFromAsar]: FuseState.ENABLE,
  [FuseV1Options.EnableCookieEncryption]: FuseState.ENABLE,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: FuseState.DISABLE,
};

const out = process.argv[2] ?? "release";
const apps = readdirSync(out)
  .filter((d) => d.startsWith("mac"))
  .map((d) => join(out, d, "Stubwise.app", "Contents", "MacOS", "Stubwise"))
  .filter((p) => existsSync(p));
if (apps.length === 0) {
  console.error(`check-fuses: nessuna app in ${out}/mac*/Stubwise.app`);
  process.exit(1);
}
let failed = false;
for (const app of apps) {
  const wire = await getCurrentFuseWire(app);
  for (const [option, state] of Object.entries(EXPECTED)) {
    if (wire[option] !== state) {
      console.error(
        `check-fuses: ${app}: ${FuseV1Options[option]} è ${wire[option]}, atteso ${state}`,
      );
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log(`check-fuses: ok (${apps.length} app)`);
