import { Switch, type SwitchProps } from "react-native";
import { colors } from "../theme/tokens";

/**
 * L'interruttore dell'app, coi colori del design e non col verde di iOS (26
 * set 2026): pomello `ink950`, traccia ambra da acceso e `line` da spento.
 *
 * Esiste perché lo «Only significant» della documentazione era uscito verde:
 * il terzo Switch scritto a mano, dopo le impostazioni e le impostazioni di
 * progetto, che i colori li ripetevano ognuno per conto suo. I colori non si
 * passano: chi ne volesse altri sta facendo un interruttore diverso.
 */
export function AppSwitch(props: Omit<SwitchProps, "thumbColor" | "trackColor">) {
  return <Switch {...props} thumbColor={colors.ink950} trackColor={{ false: colors.line, true: colors.signal }} />;
}
