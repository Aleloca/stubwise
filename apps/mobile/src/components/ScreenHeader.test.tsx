import { fireEvent, render, screen } from "@testing-library/react-native";
import "../i18n"; // inizializza i18next (nessun <I18nextProvider> nel test)
import type { AuthContextValue } from "../app/providers";
import { AuthContext } from "../app/auth-context";
import { ScreenHeader } from "./ScreenHeader";

/**
 * L'avatar (unico accesso alle Impostazioni) prima viveva ANCORATO in
 * `AppProviders` (Task 20) — la sua copertura stava in `providers.test.tsx`.
 * Spostato dentro `ScreenHeader` (Task 7, App M1+M2, 11 set 2026: l'avatar
 * scorre col contenuto), la copertura si sposta con lui: `providers.tsx` non
 * renderizza più nessun bottone, solo `openSettings` sul contesto.
 */
function authValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: "authenticated",
    client: null,
    user: { id: "u1", email: "giulia@farmakom.it", role: "member", language: "it", avatarUrl: null, slackUserId: null },
    justLoggedIn: false,
    login: jest.fn(),
    completeOnboarding: jest.fn(),
    openSettings: jest.fn(),
    ...overrides,
  };
}

async function renderHeader(value: AuthContextValue, title = "Inbox", subtitle?: string) {
  return await render(
    <AuthContext.Provider value={value}>
      <ScreenHeader title={title} subtitle={subtitle} />
    </AuthContext.Provider>,
  );
}

test("mostra il titolo e, se passato, il sottotitolo", async () => {
  await renderHeader(authValue(), "Inbox", "3 da decidere");
  expect(screen.getByText("Inbox")).toBeTruthy();
  expect(screen.getByText("3 da decidere")).toBeTruthy();
});

test("nessun sottotitolo passato: nessun testo extra reso", async () => {
  await renderHeader(authValue());
  expect(screen.queryByText("3 da decidere")).toBeNull();
});

test("l'avatar mostra l'iniziale maiuscola dell'email", async () => {
  await renderHeader(authValue({ user: { id: "u1", email: "giulia@farmakom.it", role: "member", language: "it", avatarUrl: null, slackUserId: null } }));
  expect(screen.getByText("G")).toBeTruthy();
});

// Accessibilità: l'avatar è SOLO glifo (l'iniziale dell'email) — senza
// `accessibilityLabel` uno screen reader lo leggerebbe come una lettera
// sciolta, non come "apri le Impostazioni".
test("il bottone Impostazioni ha un accessibilityLabel e accessibilityRole", async () => {
  await renderHeader(authValue());
  const button = screen.getByTestId("settings-avatar-button");
  expect(button.props.accessibilityLabel).toBe("Impostazioni");
  expect(button.props.accessibilityRole).toBe("button");
});

test("toccare l'avatar chiama openSettings() dal contesto", async () => {
  const openSettings = jest.fn();
  await renderHeader(authValue({ openSettings }));

  fireEvent.press(screen.getByTestId("settings-avatar-button"));

  expect(openSettings).toHaveBeenCalledTimes(1);
});
