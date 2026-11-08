import type { BrowserContext, Page } from "@playwright/test";

/*
 * Una passkey con PRF negli e2e: l'autenticatore virtuale di Chromium, via
 * CDP (`WebAuthn.addVirtualAuthenticator`). Con `hasPrf` l'autenticatore
 * CTAP2 abilita `hmac-secret` alla registrazione e restituisce i risultati
 * PRF alle asserzioni (`clientExtensionResults.prf.results.first`, 32 byte):
 * è quanto basta perché la cassaforte apra e crei chiavi vere, con la
 * crittografia vera, senza un dispositivo.
 *
 * `isUserVerified` + `automaticPresenceSimulation` (il default) fanno sì che
 * ogni cerimonia passi da sola, senza un tocco. L'autenticatore vive nel
 * contesto del browser e le sue credenziali con lui: ogni contesto (cioè ogni
 * persona) ne ha uno suo, e le passkey di uno non sono viste dall'altro.
 */
export async function addPrfAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
    },
  });
}
