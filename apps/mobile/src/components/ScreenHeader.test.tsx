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
    loggedOut: jest.fn(),
    ...overrides,
  };
}

async function renderHeader(
  value: AuthContextValue,
  extra: {
    showAvatar?: boolean;
    title?: string;
    subtitle?: string;
    backLabel?: string;
    onBack?: () => void;
  } = {},
) {
  return await render(
    <AuthContext.Provider value={value}>
      <ScreenHeader
        title={extra.title ?? "Inbox"}
        subtitle={extra.subtitle}
        {...(extra.backLabel !== undefined ? { backLabel: extra.backLabel } : {})}
        {...(extra.onBack !== undefined ? { onBack: extra.onBack } : {})}
        {...(extra.showAvatar !== undefined ? { showAvatar: extra.showAvatar } : {})}
      />
    </AuthContext.Provider>,
  );
}

test("mostra il titolo e, se passato, il sottotitolo", async () => {
  await renderHeader(authValue(), { title: "Inbox", subtitle: "3 da decidere" });
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
  // `openSettings` dal 16 set 2026 NAVIGA alla pagina invece di aprire uno
  // sheet, ma il canale resta il contesto: l'avatar non sa (e non deve
  // sapere) se le Impostazioni siano una pagina o un pannello.
  const openSettings = jest.fn();
  await renderHeader(authValue({ openSettings }));

  fireEvent.press(screen.getByTestId("settings-avatar-button"));

  expect(openSettings).toHaveBeenCalledTimes(1);
});

test("l'avatar si può nascondere: è la pagina Impostazioni stessa", async () => {
  // Unico caso in tutta l'app: lì l'avatar porterebbe a se stesso.
  await renderHeader(authValue({}), { showAvatar: false });
  expect(screen.queryByTestId("settings-avatar-button")).toBeNull();
});

/**
 * ⚠️ LA CHEVRON DELL'INDIETRO LA METTE IL COMPONENTE (23 set 2026).
 *
 * Il difetto che questi test presidiano è stato trovato dal maintainer sul
 * telefono: fino a qui la chevron viveva dentro le stringhe tradotte («‹
 * Progetti») e in un template scritto a mano in `WorkScreen`. Finché
 * l'etichetta era una costante nostra funzionava; dalle schermate dell'hub
 * di progetto `backLabel` è il NOME DI UN PROGETTO, che arriva dal database,
 * e compariva nudo — indistinguibile da un sottotitolo, senza niente che
 * dicesse «questo riporta indietro».
 *
 * Il test con un'etichetta ARBITRARIA è quello che conta: uno scritto su una
 * costante tradotta passerebbe anche se la chevron tornasse dentro le
 * traduzioni, cioè proprio nel posto dove si può dimenticare.
 */
test("l'indietro porta la chevron anche su un'etichetta che non è una nostra costante", async () => {
  await renderHeader(authValue({}), { backLabel: "Portale B2B", onBack: () => {} });
  expect(screen.getByText("‹ Portale B2B")).toBeTruthy();
});

test("senza `onBack` non c'è nessun indietro da disegnare", async () => {
  // Il NEGATIVO: senza, un header che mostrasse una chevron sciolta su ogni
  // schermata di primo livello passerebbe il test qui sopra.
  await renderHeader(authValue({}));
  expect(screen.queryByTestId("screen-header-back")).toBeNull();
});
