// Task 21: test su file temporanei per version-bump.mjs. Nessun file reale
// del progetto viene toccato: le fixture (pbxproj/gradle/package.json) sono
// scritte in una dir temp creata ad hoc e ripulita a fine test.
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  updatePbxprojVersion,
  updateGradleVersion,
  computeBuildNumber,
  run,
} from "./version-bump.mjs";

// Fixture minimale ma fedele al pbxproj reale: DUE blocchi di build config
// (Debug/Release), ciascuno con la propria coppia MARKETING_VERSION /
// CURRENT_PROJECT_VERSION — lo script deve aggiornarle entrambe.
const PBXPROJ_FIXTURE = `
		13B07F941A680F5B00A75B9A /* Debug */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CURRENT_PROJECT_VERSION = 1;
				MARKETING_VERSION = 1.0;
				PRODUCT_NAME = StubwiseMobile;
			};
			name = Debug;
		};
		13B07F951A680F5B00A75B9A /* Release */ = {
			isa = XCBuildConfiguration;
			buildSettings = {
				CURRENT_PROJECT_VERSION = 1;
				MARKETING_VERSION = 1.0;
				PRODUCT_NAME = StubwiseMobile;
			};
			name = Release;
		};
`;

const GRADLE_FIXTURE = `
android {
    namespace "com.app.aleloca.stubwise"
    defaultConfig {
        applicationId "com.app.aleloca.stubwise"
        versionCode 1
        versionName "1.0"
    }
}
`;

describe("updatePbxprojVersion", () => {
  test("aggiorna MARKETING_VERSION e CURRENT_PROJECT_VERSION in entrambe le build config", () => {
    const result = updatePbxprojVersion(PBXPROJ_FIXTURE, {
      version: "1.2.3",
      buildNumber: 7,
    });

    const marketing = result.match(/MARKETING_VERSION = ([^;]+);/g);
    const current = result.match(/CURRENT_PROJECT_VERSION = ([^;]+);/g);

    expect(marketing).toEqual([
      "MARKETING_VERSION = 1.2.3;",
      "MARKETING_VERSION = 1.2.3;",
    ]);
    expect(current).toEqual([
      "CURRENT_PROJECT_VERSION = 7;",
      "CURRENT_PROJECT_VERSION = 7;",
    ]);
  });

  test("lancia un errore chiaro se manca MARKETING_VERSION", () => {
    const broken = PBXPROJ_FIXTURE.replace(/MARKETING_VERSION = 1\.0;/g, "");

    expect(() =>
      updatePbxprojVersion(broken, { version: "1.2.3", buildNumber: 7 }),
    ).toThrow(/MARKETING_VERSION/);
  });

  test("lancia un errore chiaro se manca CURRENT_PROJECT_VERSION", () => {
    const broken = PBXPROJ_FIXTURE.replace(
      /CURRENT_PROJECT_VERSION = 1;/g,
      "",
    );

    expect(() =>
      updatePbxprojVersion(broken, { version: "1.2.3", buildNumber: 7 }),
    ).toThrow(/CURRENT_PROJECT_VERSION/);
  });

  test("lancia su un pbxproj malformato senza il ';' finale (il match non deve scavalcare la riga)", () => {
    const malformed = PBXPROJ_FIXTURE.replaceAll(
      "MARKETING_VERSION = 1.0;",
      "MARKETING_VERSION = 1.0",
    );

    expect(() =>
      updatePbxprojVersion(malformed, { version: "1.2.3", buildNumber: 7 }),
    ).toThrow(/MARKETING_VERSION/);
  });

  test("una chiamata precedente che fallisce dopo un match parziale non 'avvelena' le chiamate successive (statefulness di regex globali)", () => {
    // Contenuto con un MARKETING_VERSION valido ma molto più avanti nella
    // stringa (padding lungo davanti) e SENZA CURRENT_PROJECT_VERSION: la
    // guardia su MARKETING_VERSION incontra un match (e con una regex `g`
    // riusata, `.test()` sposterebbe `lastIndex` oltre quel punto), poi la
    // guardia su CURRENT_PROJECT_VERSION fallisce e lancia PRIMA che si
    // arrivi mai a un `.replace()` — che è l'unico punto che, sulle regex `g`
    // condivise, resetterebbe `lastIndex` a 0.
    const padding = "x".repeat(600);
    const poisoning = `${padding}\nMARKETING_VERSION = 1.0;\n`;
    expect(() =>
      updatePbxprojVersion(poisoning, { version: "9.9.9", buildNumber: 1 }),
    ).toThrow(/CURRENT_PROJECT_VERSION/);

    // Una chiamata successiva, su un contenuto valido ma con il match
    // MOLTO prima del punto in cui la regex `g` sarebbe rimasta "ferma",
    // deve comunque riconoscere il pattern — non fallire con un falso
    // negativo dovuto al `lastIndex` sporco della chiamata precedente.
    const result = updatePbxprojVersion(PBXPROJ_FIXTURE, {
      version: "1.2.3",
      buildNumber: 7,
    });
    expect(result).toContain("MARKETING_VERSION = 1.2.3;");
    expect(result).toContain("CURRENT_PROJECT_VERSION = 7;");
  });
});

describe("updateGradleVersion", () => {
  test("aggiorna versionCode e versionName in defaultConfig", () => {
    const result = updateGradleVersion(GRADLE_FIXTURE, {
      version: "1.2.3",
      buildNumber: 7,
    });

    expect(result).toContain("versionCode 7");
    expect(result).toContain('versionName "1.2.3"');
    expect(result).not.toContain("versionCode 1\n");
    expect(result).not.toContain('versionName "1.0"');
  });

  test("lancia un errore chiaro se manca versionCode", () => {
    const broken = GRADLE_FIXTURE.replace("versionCode 1\n", "");

    expect(() =>
      updateGradleVersion(broken, { version: "1.2.3", buildNumber: 7 }),
    ).toThrow(/versionCode/);
  });

  test("lancia un errore chiaro se manca versionName", () => {
    const broken = GRADLE_FIXTURE.replace('versionName "1.0"\n', "");

    expect(() =>
      updateGradleVersion(broken, { version: "1.2.3", buildNumber: 7 }),
    ).toThrow(/versionName/);
  });

  test("lancia se versionCode compare più di una volta (es. productFlavors futuri)", () => {
    const withFlavor = GRADLE_FIXTURE.replace(
      "versionCode 1\n",
      "versionCode 1\n        versionCode 2\n",
    );

    expect(() =>
      updateGradleVersion(withFlavor, { version: "1.2.3", buildNumber: 7 }),
    ).toThrow(/versionCode/);
  });

  test("lancia se versionName compare più di una volta (es. productFlavors futuri)", () => {
    const withFlavor = GRADLE_FIXTURE.replace(
      'versionName "1.0"\n',
      'versionName "1.0"\n        versionName "1.1"\n',
    );

    expect(() =>
      updateGradleVersion(withFlavor, { version: "1.2.3", buildNumber: 7 }),
    ).toThrow(/versionName/);
  });
});

describe("computeBuildNumber", () => {
  test("parte da 1 quando package.json non ha ancora buildNumber", () => {
    expect(computeBuildNumber({ version: "1.0.0" })).toBe(1);
  });

  test("incrementa di 1 il buildNumber esistente", () => {
    expect(computeBuildNumber({ version: "1.0.0", buildNumber: 5 })).toBe(6);
  });

  test("lancia se buildNumber è una stringa (niente reset silenzioso a 1)", () => {
    expect(() =>
      computeBuildNumber({ version: "1.0.0", buildNumber: "5" }),
    ).toThrow(/buildNumber/);
  });

  test("lancia se buildNumber è un float", () => {
    expect(() =>
      computeBuildNumber({ version: "1.0.0", buildNumber: 5.5 }),
    ).toThrow(/buildNumber/);
  });

  test("lancia se buildNumber è negativo", () => {
    expect(() =>
      computeBuildNumber({ version: "1.0.0", buildNumber: -1 }),
    ).toThrow(/buildNumber/);
  });
});

describe("run (end-to-end su fixture temporanee)", () => {
  let mobileRoot;

  beforeEach(async () => {
    mobileRoot = await mkdtemp(path.join(tmpdir(), "stubwise-mobile-"));
    await mkdir(path.join(mobileRoot, "ios", "StubwiseMobile.xcodeproj"), {
      recursive: true,
    });
    await mkdir(path.join(mobileRoot, "android", "app"), { recursive: true });

    await writeFile(
      path.join(mobileRoot, "package.json"),
      JSON.stringify({ name: "@stubwise/mobile", version: "1.2.3" }, null, 2) +
        "\n",
    );
    await writeFile(
      path.join(
        mobileRoot,
        "ios",
        "StubwiseMobile.xcodeproj",
        "project.pbxproj",
      ),
      PBXPROJ_FIXTURE,
    );
    await writeFile(
      path.join(mobileRoot, "android", "app", "build.gradle"),
      GRADLE_FIXTURE,
    );
  });

  afterEach(async () => {
    await rm(mobileRoot, { recursive: true, force: true });
  });

  test("scrive la versione su iOS/Android e persiste+incrementa buildNumber in package.json", async () => {
    const result = await run({ mobileRoot, log: () => {} });

    expect(result).toEqual({ version: "1.2.3", buildNumber: 1 });

    const pkg = JSON.parse(
      await readFile(path.join(mobileRoot, "package.json"), "utf8"),
    );
    expect(pkg.buildNumber).toBe(1);
    expect(pkg.version).toBe("1.2.3");

    const pbxproj = await readFile(
      path.join(
        mobileRoot,
        "ios",
        "StubwiseMobile.xcodeproj",
        "project.pbxproj",
      ),
      "utf8",
    );
    expect(pbxproj).toContain("MARKETING_VERSION = 1.2.3;");
    expect(pbxproj).toContain("CURRENT_PROJECT_VERSION = 1;");

    const gradle = await readFile(
      path.join(mobileRoot, "android", "app", "build.gradle"),
      "utf8",
    );
    expect(gradle).toContain('versionName "1.2.3"');
    expect(gradle).toContain("versionCode 1");
  });

  test("un secondo run incrementa ulteriormente il buildNumber (monotono)", async () => {
    await run({ mobileRoot, log: () => {} });
    const second = await run({ mobileRoot, log: () => {} });

    expect(second.buildNumber).toBe(2);

    const gradle = await readFile(
      path.join(mobileRoot, "android", "app", "build.gradle"),
      "utf8",
    );
    expect(gradle).toContain("versionCode 2");
  });

  test("propaga l'errore e non va in crash silenzioso se il gradle è malformato, senza scritture parziali", async () => {
    await writeFile(
      path.join(mobileRoot, "android", "app", "build.gradle"),
      "// nessun versionCode qui\n",
    );

    const pbxprojPath = path.join(
      mobileRoot,
      "ios",
      "StubwiseMobile.xcodeproj",
      "project.pbxproj",
    );
    const packageJsonPath = path.join(mobileRoot, "package.json");
    const pbxprojBefore = await readFile(pbxprojPath, "utf8");
    const packageJsonBefore = await readFile(packageJsonPath, "utf8");

    await expect(run({ mobileRoot, log: () => {} })).rejects.toThrow(
      /versionCode/,
    );

    // Proprietà di sicurezza più importante dello script: un fallimento nel
    // parsing di UN file non deve lasciare gli ALTRI file a metà aggiornati
    // (qui il pbxproj, letto e validato PRIMA del gradle malformato, e
    // package.json, scritto per ultimo) — bit per bit identici a prima.
    expect(await readFile(pbxprojPath, "utf8")).toBe(pbxprojBefore);
    expect(await readFile(packageJsonPath, "utf8")).toBe(packageJsonBefore);
  });
});
