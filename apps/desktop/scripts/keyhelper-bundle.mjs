// L'identità e i file del bundle dell'helper del Secure Enclave (seconda
// revisione di sicurezza della cassaforte, I1). Una fonte sola,
// `native/keyhelper/identity.json`, per il main (requisito di firma e
// percorso), questi script e i test; `main.swift` scrive il suffisso del
// gruppo a mano, e un test di parità lo confronta.
import { readFileSync } from "node:fs";

export const identity = JSON.parse(
  readFileSync(new URL("../native/keyhelper/identity.json", import.meta.url), "utf8"),
);

const plist = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${body}
</dict></plist>
`;

/** L'Info.plist del bundle: l'identifier della firma, nessuna icona nel Dock. */
export function helperInfoPlist() {
  return plist(
    [
      `<key>CFBundleIdentifier</key><string>${identity.bundleId}</string>`,
      `<key>CFBundleName</key><string>${identity.bundleName}</string>`,
      `<key>CFBundleExecutable</key><string>${identity.executable}</string>`,
      "<key>CFBundlePackageType</key><string>APPL</string>",
      "<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>",
      "<key>CFBundleVersion</key><string>1</string>",
      "<key>LSMinimumSystemVersion</key><string>13.0</string>",
      "<key>LSUIElement</key><true/>",
    ].join("\n"),
  );
}

/**
 * Gli entitlements dell'helper firmato: l'application-identifier e il team
 * (che il profilo di provisioning autorizza) e il solo gruppo del Keychain
 * della cassaforte. Niente altro: l'app resta col solo allow-jit.
 */
export function helperEntitlements(teamId) {
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) throw new Error("Team ID non valido");
  return plist(
    [
      `<key>com.apple.application-identifier</key><string>${teamId}.${identity.bundleId}</string>`,
      `<key>com.apple.developer.team-identifier</key><string>${teamId}</string>`,
      `<key>keychain-access-groups</key><array><string>${teamId}.${identity.accessGroupSuffix}</string></array>`,
    ].join("\n"),
  );
}
