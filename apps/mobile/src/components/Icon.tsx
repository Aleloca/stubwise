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
  /** `reply` (Material Symbols Outlined, 24px) — `assets/icons/reply.svg`. */
  reply:
    "M760-200v-160q0-50-35-85t-85-35H273l144 144-57 56-240-240 240-240 57 56-144 144h367q83 0 141.5 58.5T840-360v160h-80Z",
  /** `edit` (Material Symbols Outlined, 24px) — `assets/icons/edit.svg`. */
  edit:
    "M200-200h57l391-391-57-57-391 391v57Zm-80 80v-170l528-527q12-11 26.5-17t30.5-6q16 0 31 6t26 18l55 56q12 11 17.5 26t5.5 30q0 16-5.5 30.5T817-647L290-120H120Zm640-584-56-56 56 56Zm-141 85-28-29 57 57-29-28Z",
  /** `delete` (Material Symbols Outlined, 24px) — `assets/icons/delete.svg`. */
  delete:
    "M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z",
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
