import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";

/**
 * L'ALTEZZA DELLA BARRA, portata FUORI dalle scene (25 set 2026, design §11).
 *
 * Il cerchio di Wisey sta SOPRA le schede e va agganciato all'altezza vera
 * della barra (safe area compresa), non a un numero scritto a mano. La
 * libreria la misura (`TabViewImpl.swift:76`, il frame della `UITabBar`) ma
 * la tiene per sé, verificato su `react-native-bottom-tabs` 1.4.0:
 * - `TabView.tsx:431` la mette in uno stato proprio (`handleTabBarMeasured`);
 * - `TabView.tsx:455` la espone SOLO come `BottomTabBarHeightContext`
 *   attorno alle scene;
 * - `TabView.tsx:457/470`: il suo handler viene dopo `{...props}`, quindi un
 *   nostro `onTabBarMeasured` verrebbe sovrascritto;
 * - `useBottomTabBarHeight()` lancia fuori da una scena.
 *
 * Quindi un RIPORTATORE invisibile ({@link TabBarHeightReporter}), montato
 * dentro una scena, la legge e la scrive in questo contesto, sopra le schede,
 * dove la legge il cerchio. Sta nella scena di INBOX perché è la tab
 * iniziale: si monta per prima e resta montata. ⚠️ Non basta però che sia
 * l'iniziale: le scene sono pigre (si montano quando le visiti), e un deep
 * link può aprire l'app su un'altra tab — per questo la tab Inbox ha
 * `lazy: false` (`navigation.tsx`), e si monta all'avvio in ogni caso.
 *
 * Prima della prima misura il valore è 0, e il cerchio non compare: meglio
 * niente di un cerchio fuori posto.
 */
export const TabBarHeightContext = createContext<{ height: number; setHeight: (height: number) => void }>({
  height: 0,
  setHeight: () => {},
});

export function TabBarHeightProvider({ children }: { children: ReactNode }) {
  const [height, setHeight] = useState(0);
  const value = useMemo(() => ({ height, setHeight }), [height]);
  return <TabBarHeightContext.Provider value={value}>{children}</TabBarHeightContext.Provider>;
}

/** L'altezza misurata della barra, 0 finché non c'è. */
export function useTabBarHeight(): number {
  return useContext(TabBarHeightContext).height;
}

/** Invisibile: va montato DENTRO una scena del navigatore delle schede. */
export function TabBarHeightReporter() {
  const height = useBottomTabBarHeight();
  const { setHeight } = useContext(TabBarHeightContext);
  useEffect(() => {
    setHeight(height);
  }, [height, setHeight]);
  return null;
}
