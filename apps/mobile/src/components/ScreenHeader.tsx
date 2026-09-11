import { StyleSheet, Text, View } from "react-native";
import { SettingsAvatarButton } from "./SettingsAvatarButton";
import { colors } from "../theme/tokens";
import { textStyles } from "../theme/typography";

/**
 * Intestazione di schermata (Task 7, App M1+M2, 11 set 2026): titolo +
 * sottotitolo opzionale + l'avatar (unico accesso alle Impostazioni). Va
 * come PRIMO figlio dentro lo `ScrollView` di ogni schermata — mai fratello,
 * o torna il problema che questo task risolve (l'header fermo, il contenuto
 * che scorre sotto la tab bar nativa senza un margine) — E il chiamante deve
 * passare `stickyHeaderIndices={[0]}` allo `ScrollView` (fix di review
 * dell'11 set 2026, Task 2, vedi sotto).
 *
 * L'avatar prima viveva ANCORATO in `AppProviders` (Task 20), fuori dal
 * contenuto scorrevole. Decisione del maintainer: scorre col contenuto,
 * come i titoli grandi di iOS — il banner offline (stato del sistema, non
 * pezzo di pagina) resta ancorato lì, l'avatar no.
 *
 * **Fix di review (11 set 2026,
 * `docs/plans/2026-09-11-app-m1-m2-review-fixes-plan.md`, Task 2)**: il Task
 * 7 aveva lasciato l'avatar scorrere via SENZA restare ancorato da nessuna
 * parte — il design parlava di un header che scorre "e si contrae, come i
 * titoli grandi di iOS": la contrazione era il punto, perché lì la barra
 * compatta resta ancorata. Qui si ottiene lo STESSO risultato (le
 * Impostazioni raggiungibili da qualunque posizione di scorrimento) con un
 * meccanismo più semplice della vera animazione di contrazione:
 * `stickyHeaderIndices={[0]}` di `ScrollView` — nativo di React Native, non
 * codice scritto a mano — fissa questo header in cima per tutta la durata
 * dello scroll, invece di farlo scorrere via. `backgroundColor` qui sotto è
 * necessario per questo: senza, il contenuto sotto lo attraverserebbe
 * visivamente scorrendo.
 */
export function ScreenHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.row}>
      <View style={styles.titleBlock}>
        <Text style={textStyles.screenTitle}>{title}</Text>
        {subtitle !== undefined && <Text style={textStyles.screenSubtitle}>{subtitle}</Text>}
      </View>
      <SettingsAvatarButton />
    </View>
  );
}

const styles = StyleSheet.create({
  // `paddingHorizontal: 20`/`paddingTop: 56` erano ripetuti IDENTICI in ogni
  // schermata tab-root prima di questo task (Inbox/Projects/Backlog/Docs):
  // qui vivono in UN posto solo. `paddingTop: 56` è lo stesso margine fisso
  // già in uso in tutto l'app per lo spazio della status bar (nessuno
  // screen di questo repo usa `useSafeAreaInsets` — non è la convenzione
  // esistente, e non è questo il task per cambiarla). `backgroundColor`
  // (fix di review, Task 2): necessario perché l'header è ora ANCORATO
  // (`stickyHeaderIndices`) — senza, il contenuto sotto lo attraverserebbe.
  row: {
    alignItems: "flex-start",
    backgroundColor: colors.ink950,
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    paddingBottom: 12,
    paddingHorizontal: 20,
    paddingTop: 56,
  },
  titleBlock: {
    flex: 1,
  },
});
