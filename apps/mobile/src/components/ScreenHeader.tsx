import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../app/providers";
import { colors } from "../theme/tokens";
import { fontFamily, textStyles } from "../theme/typography";

/**
 * Intestazione di schermata (Task 7, App M1+M2, 11 set 2026): titolo +
 * sottotitolo opzionale + l'avatar (unico accesso alle Impostazioni). Va
 * come PRIMO figlio dentro lo `ScrollView` di ogni schermata — mai fratello,
 * o torna il problema che questo task risolve (l'header fermo, il contenuto
 * che scorre sotto la tab bar nativa senza un margine).
 *
 * L'avatar prima viveva ANCORATO in `AppProviders` (Task 20), fuori dal
 * contenuto scorrevole. Decisione del maintainer: scorre col contenuto,
 * come i titoli grandi di iOS — il banner offline (stato del sistema, non
 * pezzo di pagina) resta ancorato lì, l'avatar no. Un piccolo componente
 * condiviso invece di ripetere Pressable+iniziale+`openSettings` in ogni
 * schermata: la sigla del titolo usa `textStyles.screenTitle`/
 * `screenSubtitle` per lo stesso motivo (vedi `theme/typography.ts`).
 *
 * ⚠️ Con l'avatar dentro il contenuto scorrevole, su una lista lunga scesa
 * oltre la prima schermata l'avatar non è più a vista — va risalito. Vedi il
 * commento su `showChrome` in `app/providers.tsx` per il tradeoff per
 * esteso: è la scelta più semplice, non la più sicura, e va verificata sul
 * telefono (Task 8).
 */
export function ScreenHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const { t } = useTranslation();
  const { user, openSettings } = useAuth();
  const avatarInitial = user !== null ? user.email.charAt(0).toUpperCase() : "";

  return (
    <View style={styles.row}>
      <View style={styles.titleBlock}>
        <Text style={textStyles.screenTitle}>{title}</Text>
        {subtitle !== undefined && <Text style={textStyles.screenSubtitle}>{subtitle}</Text>}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("mobile.settings.openLabel")}
        onPress={openSettings}
        style={styles.avatarButton}
        testID="settings-avatar-button"
      >
        <Text style={styles.avatarLabel}>{avatarInitial}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // `paddingHorizontal: 20`/`paddingTop: 56` erano ripetuti IDENTICI in ogni
  // schermata tab-root prima di questo task (Inbox/Projects/Backlog/Docs):
  // qui vivono in UN posto solo. `paddingTop: 56` è lo stesso margine fisso
  // già in uso in tutto l'app per lo spazio della status bar (nessuno
  // screen di questo repo usa `useSafeAreaInsets` — non è la convenzione
  // esistente, e non è questo il task per cambiarla).
  row: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 56,
  },
  titleBlock: {
    flex: 1,
  },
  avatarButton: {
    alignItems: "center",
    backgroundColor: colors.ink800,
    borderRadius: 16,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  avatarLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
});
