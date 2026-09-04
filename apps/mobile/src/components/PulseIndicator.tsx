import { StyleSheet, Text, View } from "react-native";
import type { PulseTone } from "../lib/pulse-line";
import { colors } from "../theme/tokens";
import { fontFamily } from "../theme/typography";

/**
 * Pallino + testo colorato sul tono del polso (canvas `2a`/`2b`): l'unità
 * visiva minima che dice "cosa succede" a colpo d'occhio, prima ancora di
 * leggere la frase. Estratto da `PulseRow` (riga di lista) e dall'intestazione
 * di `ProjectDetailScreen` — stesso markup e stessi stili, duplicati fra i
 * due fino al Task 15 (revisione di qualità). Fuori da `components/projects/`
 * perché non è specifico dei Progetti: è il vocabolario visivo del polso, e
 * il Task 16 (Lavoro) userà lo stesso tono per "sta lavorando da N min".
 *
 * Vive fuori da `CardShell.tsx` (il `kindRow` dell'inbox, stesso concetto ma
 * NON identico: pallino più piccolo, testo mono maiuscolo con letter-spacing)
 * di proposito: unificare anche quello avrebbe voluto dire toccare stili già
 * approvati e coperti da test dell'inbox per un guadagno marginale — vedi la
 * nota di revisione del Task 15. `tone` è già `PulseTone` (il sottoinsieme di
 * `ColorToken` di `lib/pulse-line.ts`), non l'intero `ColorToken` di
 * `CardShell`: i due pallini restano concettualmente distinti anche se si
 * assomigliano.
 */
export function PulseIndicator({ tone, text }: { tone: PulseTone; text: string }) {
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: colors[tone] }]} />
      <Text style={[styles.text, { color: colors[tone] }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  dot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  text: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
});
