#!/usr/bin/env node
// Task 21: propaga la `version` di apps/mobile/package.json e un
// `buildNumber` incrementale su iOS e Android, prima di un archive/release.
//
// Perché non Info.plist: `CFBundleShortVersionString`/`CFBundleVersion` in
// StubwiseMobile/Info.plist sono già `$(MARKETING_VERSION)` /
// `$(CURRENT_PROJECT_VERSION)` — sostituzione di build setting fatta da
// Xcode in fase di processing del plist, non valori letterali. Scrivere una
// stringa letterale in Info.plist sarebbe innocuo quanto inutile: Xcode la
// sovrascriverebbe comunque con quei due build setting. La sorgente di
// verità reale sono `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in
// ios/StubwiseMobile.xcodeproj/project.pbxproj (una coppia per ogni build
// config, Debug e Release) — è lì che questo script scrive.
//
// Su Android `versionName`/`versionCode` sono letterali in
// android/app/build.gradle (defaultConfig), niente indirection: si scrive
// direttamente lì.
//
// `buildNumber`: persistito in package.json, **incrementato a ogni run**
// (non "impostato" idempotente) — è il numero di build incrementale che
// Apple/Google richiedono monotono crescente a ogni archive/release
// pubblicato, quindi il comportamento naturale di questo script è bump ad
// ogni invocazione, non un no-op su run ripetuti con la stessa `version`.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// `[^;\n]` (non `[^;]`) tiene il match sulla singola riga: senza il `;`
// finale un `[^;]+` greedy scavalcherebbe l'a-capo e si fermerebbe al
// prossimo `;` incontrato più sotto nel file (es. quello di una riga
// `PRODUCT_NAME = ...;` successiva), sostituendo silenziosamente contenuto
// sbagliato invece di fallire in modo rumoroso su un pbxproj malformato.
//
// Due varianti per pattern: una SENZA `g` per il controllo di esistenza, una
// CON `g` per la sostituzione. Le regex con `g` sono stateful (`lastIndex`
// sopravvive tra le chiamate a `.test()`); una guardia che throw PRIMA di
// arrivare al `.replace()` che lo resetterebbe lascia `lastIndex` sporco per
// la chiamata successiva sullo STESSO oggetto regex (riusato perché è una
// const di modulo) — un `.test()` seguente potrebbe ripartire a metà
// stringa e dare un falso negativo. Tenerle separate evita il problema alla
// radice invece di contare sui dettagli di reset della spec.
const MARKETING_VERSION_CHECK_RE = /MARKETING_VERSION = [^;\n]+;/;
const MARKETING_VERSION_REPLACE_RE = /MARKETING_VERSION = [^;\n]+;/g;
const CURRENT_PROJECT_VERSION_CHECK_RE = /CURRENT_PROJECT_VERSION = [^;\n]+;/;
const CURRENT_PROJECT_VERSION_REPLACE_RE =
  /CURRENT_PROJECT_VERSION = [^;\n]+;/g;
const VERSION_CODE_RE = /versionCode\s+\d+/;
const VERSION_NAME_RE = /versionName\s+"[^"]*"/;

/**
 * Sostituisce MARKETING_VERSION e CURRENT_PROJECT_VERSION in TUTTI i build
 * config trovati (tipicamente Debug + Release). Fallisce rumorosamente se
 * uno dei due pattern non compare almeno una volta: meglio un errore visibile
 * che uno "0 sostituzioni" silenzioso su un pbxproj che è cambiato forma.
 */
export function updatePbxprojVersion(content, { version, buildNumber }) {
  if (!MARKETING_VERSION_CHECK_RE.test(content)) {
    throw new Error(
      "version-bump: pattern MARKETING_VERSION non trovato nel pbxproj (formato inatteso?)",
    );
  }
  if (!CURRENT_PROJECT_VERSION_CHECK_RE.test(content)) {
    throw new Error(
      "version-bump: pattern CURRENT_PROJECT_VERSION non trovato nel pbxproj (formato inatteso?)",
    );
  }

  return content
    .replace(MARKETING_VERSION_REPLACE_RE, `MARKETING_VERSION = ${version};`)
    .replace(
      CURRENT_PROJECT_VERSION_REPLACE_RE,
      `CURRENT_PROJECT_VERSION = ${buildNumber};`,
    );
}

/**
 * Sostituisce versionCode/versionName in android/app/build.gradle
 * (defaultConfig). Un solo occorrenza attesa per ciascuno (nessun flag `g`:
 * niente statefulness da gestire), quindi qui il controllo di esistenza e la
 * sostituzione possono condividere lo stesso pattern. Fallisce rumorosamente
 * se il pattern non c'è.
 */
export function updateGradleVersion(content, { version, buildNumber }) {
  if (!VERSION_CODE_RE.test(content)) {
    throw new Error(
      "version-bump: pattern versionCode non trovato in build.gradle (formato inatteso?)",
    );
  }
  if (!VERSION_NAME_RE.test(content)) {
    throw new Error(
      "version-bump: pattern versionName non trovato in build.gradle (formato inatteso?)",
    );
  }

  return content
    .replace(VERSION_CODE_RE, `versionCode ${buildNumber}`)
    .replace(VERSION_NAME_RE, `versionName "${version}"`);
}

/** Il prossimo buildNumber: 1 se package.json non ne ha ancora uno, altrimenti +1. */
export function computeBuildNumber(pkg) {
  const current = typeof pkg.buildNumber === "number" ? pkg.buildNumber : 0;
  return current + 1;
}

/**
 * Orchestrazione end-to-end: legge package.json, calcola il buildNumber,
 * scrive pbxproj + build.gradle + package.json (buildNumber persistito).
 * `mobileRoot` è obbligatorio (niente default implicito su "apps/mobile
 * reale": un default silenzioso qui sarebbe pericoloso nei test — un test
 * che dimentica di passarlo finirebbe per scrivere sui file veri del
 * progetto invece che sulla fixture temporanea). Il guard CLI in fondo al
 * file lo passa sempre esplicitamente.
 */
export async function run({ mobileRoot, log = console.log }) {
  if (!mobileRoot) {
    throw new Error("version-bump: run() richiede 'mobileRoot'");
  }
  const packageJsonPath = path.join(mobileRoot, "package.json");
  const pbxprojPath = path.join(
    mobileRoot,
    "ios",
    "StubwiseMobile.xcodeproj",
    "project.pbxproj",
  );
  const gradlePath = path.join(mobileRoot, "android", "app", "build.gradle");

  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const { version } = pkg;
  if (!version) {
    throw new Error("version-bump: package.json non ha un campo 'version'");
  }
  const buildNumber = computeBuildNumber(pkg);

  const pbxprojContent = await readFile(pbxprojPath, "utf8");
  const updatedPbxproj = updatePbxprojVersion(pbxprojContent, {
    version,
    buildNumber,
  });

  const gradleContent = await readFile(gradlePath, "utf8");
  const updatedGradle = updateGradleVersion(gradleContent, {
    version,
    buildNumber,
  });

  // Le scritture sui file di piattaforma avvengono solo dopo che ENTRAMBI i
  // parsing sono andati a buon fine: se uno dei due pattern manca, l'errore
  // viene lanciato prima di toccare qualunque file su disco (vedi i due
  // `await readFile` + `update*Version` sopra, entrambi prima dei `writeFile`
  // sotto).
  await writeFile(pbxprojPath, updatedPbxproj);
  await writeFile(gradlePath, updatedGradle);
  await writeFile(
    packageJsonPath,
    JSON.stringify({ ...pkg, buildNumber }, null, 2) + "\n",
  );

  log(
    `version-bump: version=${version} buildNumber=${buildNumber} scritti su iOS (pbxproj) e Android (build.gradle)`,
  );

  return { version, buildNumber };
}

// Rilevamento "sono lo script principale" senza `import.meta.url`: questo
// file è .mjs (ESM reale, eseguito con `node scripts/version-bump.mjs`), ma
// il test .mjs affiancato passa da Jest, che lo trasforma in CommonJS via
// babel-jest — e babel-preset-env non converte `import.meta` in qualcosa di
// valido sotto CJS (resterebbe un token illegale a runtime: "Cannot use
// 'import.meta' outside a module"). Guardiamo invece su `process.argv[1]`:
// quando Node esegue questo file direttamente è il path di QUESTO script;
// quando il modulo viene importato (dal test, o da un altro entrypoint)
// `process.argv[1]` è il path di quell'altro processo, il confronto fallisce
// e il ramo CLI non scatta — nessun side effect al semplice `import`.
if (process.argv[1] && process.argv[1].endsWith("version-bump.mjs")) {
  const mobileRoot = path.resolve(path.dirname(process.argv[1]), "..");
  run({ mobileRoot }).catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
