import type { StubwiseClient } from "@stubwise/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen } from "@testing-library/react-native";
import { BottomTabBarHeightContext } from "react-native-bottom-tabs";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { AuthContext } from "../app/auth-context";
import type { AuthContextValue } from "../app/providers";
import "../i18n";
import { MailRejectionsScreen } from "../screens/mbx/MailRejectionsScreen";
import { useBottomTabBarHeightSafe } from "./tab-bar-height-safe";

/**
 * `jest.setup.ts` mocka `useBottomTabBarHeight` → 0 per TUTTA la suite, quindi
 * lì nemmeno l'originale lancerebbe. Qui si usa il pacchetto VERO: è l'unico
 * modo di provare che fuori dalle tab l'originale lancia e il sicuro no.
 */
jest.mock("react-native-bottom-tabs", () => ({
  __esModule: true,
  ...jest.requireActual("react-native-bottom-tabs"),
  useBottomTabBarHeight: jest.requireActual("react-native-bottom-tabs").useBottomTabBarHeight,
}));

const INSETS = { top: 0, left: 0, right: 0, bottom: 34 };

describe("useBottomTabBarHeightSafe", () => {
  test("dentro le tab restituisce l'altezza della barra", async () => {
    const { result } = await renderHook(() => useBottomTabBarHeightSafe(), {
      wrapper: ({ children }) => (
        <SafeAreaInsetsContext.Provider value={INSETS}>
          <BottomTabBarHeightContext.Provider value={83}>{children}</BottomTabBarHeightContext.Provider>
        </SafeAreaInsetsContext.Provider>
      ),
    });
    expect(result.current).toBe(83);
  });

  test("fuori dalle tab restituisce l'inset in basso (l'indicatore home), non 0", async () => {
    const { result } = await renderHook(() => useBottomTabBarHeightSafe(), {
      wrapper: ({ children }) => <SafeAreaInsetsContext.Provider value={INSETS}>{children}</SafeAreaInsetsContext.Provider>,
    });
    expect(result.current).toBe(34);
  });

  test("l'originale lancia fuori dalle tab (il motivo del hook sicuro)", async () => {
    const { useBottomTabBarHeight } = jest.requireActual("react-native-bottom-tabs");
    jest.spyOn(console, "error").mockImplementation(() => {});
    await expect(renderHook(() => useBottomTabBarHeight())).rejects.toThrow();
    (console.error as jest.Mock).mockRestore();
  });
});

describe("MailRejectionsScreen fuori dalle tab", () => {
  test("si rende senza il contesto della barra", async () => {
    const client = {
      mail: { rejections: jest.fn().mockResolvedValue({ days: 7, total: 0, accounts: [] }) },
    } as unknown as StubwiseClient;
    const authValue: AuthContextValue = {
      status: "authenticated",
      client,
      user: { id: "viewer-1", email: "op@example.com", role: "member", language: "it", avatarUrl: null, slackUserId: null },
      justLoggedIn: false,
      login: jest.fn(),
      completeOnboarding: jest.fn(),
      openSettings: jest.fn(),
      loggedOut: jest.fn(),
    };
    await render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })}>
        <AuthContext.Provider value={authValue}>
          <MailRejectionsScreen
            navigation={{ goBack: jest.fn() } as never}
            route={{ key: "MailRejections", name: "MailRejections", params: undefined }}
          />
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
    expect(screen.toJSON()).not.toBeNull();
  });
});
