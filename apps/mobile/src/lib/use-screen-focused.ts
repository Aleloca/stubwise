import { NavigationContext } from "@react-navigation/native";
import { useContext, useEffect, useState } from "react";

/**
 * La schermata è a fuoco? Letta dal `NavigationContext` e non con
 * `useIsFocused`, che lancia fuori da un navigatore: fuori da un navigatore
 * (un test di schermata, un'anteprima) si considera a fuoco.
 */
export function useScreenFocused(): boolean {
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);
  useEffect(() => {
    if (!navigation) return undefined;
    setFocused(navigation.isFocused());
    const offFocus = navigation.addListener("focus", () => setFocused(true));
    const offBlur = navigation.addListener("blur", () => setFocused(false));
    return () => {
      offFocus();
      offBlur();
    };
  }, [navigation]);
  return focused;
}
