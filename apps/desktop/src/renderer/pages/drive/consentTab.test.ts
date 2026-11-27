import { afterEach, describe, expect, it, vi } from "vitest";
import { openConsentTab } from "./consentTab";

// Revisione di sicurezza della cassaforte nel browser, M4 (27 nov 2026): la
// scheda del consenso Google si apre vuota NEL clic (Safari bloccherebbe
// quella aperta dopo), e riceve l'URL dopo. Senza `noopener` la pagina di
// Google (o chi la sostituisse) avrebbe `window.opener` su /app: la si taglia
// subito, prima che la scheda carichi qualunque cosa.

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("openConsentTab", () => {
  it("nella build web apre la scheda e ne taglia subito l'opener", () => {
    vi.stubEnv("VITE_STUBWISE_BUILD", "app");
    const tab = { opener: window as unknown, location: { href: "" } };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const got = openConsentTab();
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(got).toBe(tab);
    expect(tab.opener).toBeNull();
  });

  it("nel prototipo nessuna scheda", () => {
    const open = vi.spyOn(window, "open");
    expect(openConsentTab()).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
});
