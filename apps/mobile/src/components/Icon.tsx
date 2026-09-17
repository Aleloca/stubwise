import { Svg, Path } from "react-native-svg";
import { colors } from "../theme/tokens";

/**
 * Le icone dell'app FUORI dalla tab bar (17 set 2026).
 *
 * ⚠️ **Non è la stessa cosa delle icone della barra in basso**, ed è la
 * confusione che ha fatto nascere questo file. Quelle passano da
 * `nativeTabIcon` (`app/navigation.tsx`): su iOS sono **SF Symbol** resi dal
 * sistema dentro il `TabView` di `react-native-bottom-tabs` — niente immagini
 * caricate, coerenza automatica col Liquid Glass — e su Android SVG Material
 * decodificate dal TabView stesso. Nessuna delle due strade è utilizzabile in
 * un `<View>` qualunque: sono icone DELLA BARRA, non un set riusabile.
 *
 * Qui invece si rendono con `react-native-svg`, aggiunta apposta (dipendenza
 * NATIVA: `pod install` e un rebuild, verificati su device prima di scrivere
 * questo file — la CI non copre le build native, vedi
 * `ci-does-not-cover-native-builds` e il caso di M1+M2, dove `main` non
 * compilava per iOS dopo una dipendenza nativa nuova).
 *
 * **I path si copiano da `google/material-design-icons` verificando prima un
 * HTTP 200**, la stessa disciplina con cui sono state scelte le cinque icone
 * della barra — non a memoria, e non ridisegnandole a mano. Lo `viewBox`
 * `0 -960 960 960` è quello dei Material Symbols: non cambiarlo, o i path
 * finiscono fuori dall'area visibile.
 *
 * L'SVG di partenza resta in `assets/icons/`, accanto alle altre, così il
 * prossimo che ne aggiunge una vede da dove sono venute.
 */
const PATHS = {
  /** `search` (Material Symbols Outlined, 24px) — `assets/icons/search.svg`. */
  search:
    "M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  color = colors.muted,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 -960 960 960">
      <Path d={PATHS[name]} fill={color} />
    </Svg>
  );
}
