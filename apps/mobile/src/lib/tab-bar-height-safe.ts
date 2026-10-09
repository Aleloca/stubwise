import { useContext } from "react";
import { BottomTabBarHeightContext } from "react-native-bottom-tabs";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * L'altezza della barra delle schede, che NON lancia fuori dalle tab.
 *
 * `useBottomTabBarHeight()` (quello che usa `app/tab-bar-height.tsx`) lancia
 * «Couldn't find the bottom tab bar height» se la schermata non sta dentro una
 * scena del `TabView`. Le schermate della posta si aprono anche fuori (dal
 * profilo, dai deep link), quindi leggono il contesto direttamente.
 *
 * Fuori dalle tab non c'è barra, ma l'altezza della barra includeva l'inset
 * del home indicator: tornare 0 farebbe finire il contenuto sotto di esso, per
 * questo il ripiego è l'inset in basso.
 */
export function useBottomTabBarHeightSafe(): number {
  const tabBarHeight = useContext(BottomTabBarHeightContext);
  const insets = useSafeAreaInsets();
  return tabBarHeight ?? insets.bottom;
}
