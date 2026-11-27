import { appRoute, type AppTarget } from "@stubwise/shared";
import { describe, expect, it } from "vitest";
import { isAppRoute } from "./routes";

/**
 * I link che il server scrive verso la nuova app (`@stubwise/shared`,
 * `app-links.ts`) stanno nella grammatica di questo router. Se una rotta cambia
 * qui, questo test dice quale link del server smette di aprirsi.
 */
const UUID = "7b2c9d1e-4444-4555-8666-777788889999";
const TARGETS: AppTarget[] = [
  { to: "home" },
  { to: "task", projectCode: "ACQ", taskCode: "ACQ-12" },
  { to: "requests", projectCode: "ACQ" },
  { to: "requests", projectCode: "ACQ", requestId: UUID },
  { to: "supportRequest", projectCode: "ACQ", requestCode: "ACQ-R14" },
  { to: "project", projectCode: "ACQ" },
  { to: "project", projectCode: "ACQ", briefId: UUID },
  { to: "projectMembers", projectCode: "ACQ" },
  { to: "docs", projectCode: "ACQ" },
  { to: "productPage", projectCode: "ACQ", pageCode: "ACQ-D5" },
  { to: "server", projectCode: "STW", serverCode: "SRV-2" },
  { to: "release", projectCode: "ACQ", releaseCode: "ACQ-V3" },
  { to: "chatMessage", channelId: "ch-1", messageId: "m-1" },
  { to: "automation", automationCode: "AUD-A1" },
  { to: "automation", automationCode: "AUD-A1", runNumber: 2 },
  { to: "preferences", section: "security" },
  { to: "preferences", section: "account" },
  { to: "preferences", section: "notifications" },
];

// Il pannello di una PR (`?pr=<repository>%23<n>`) non sta in `isAppRoute`, che
// vuole `[\w-]+`: lo apre il router lo stesso, e lo prova
// `backend/real/releasesPrsPage.test.tsx` («si apre da ?pr=<repository>%23<n>»).
describe("i link del server (app-links) e la grammatica del router", () => {
  it.each(TARGETS.map((t) => [appRoute(t), t] as const))("%s è una rotta dell'app", (route) => {
    expect(isAppRoute(`#${route}`)).toBe(true);
  });
});
