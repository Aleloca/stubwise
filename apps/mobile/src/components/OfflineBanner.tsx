import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/tokens";
import { fontFamily } from "../theme/typography";

/**
 * Banner ambra "Offline — ultima sincronizzazione…" (canvas, schermata
 * 1h). `lastSyncAt` è l'ISO date scritta da `setLastSyncAt` (`lib/storage.ts`)
 * l'ultima volta che una sincronizzazione è andata a buon fine; `null` se
 * non è mai avvenuta (app appena installata, mai stata online).
 *
 * `now` è iniettabile (default `Date.now`) SOLO per i test: senza, un test
 * che verifica "12 min fa" dovrebbe o mockare `Date.now` globalmente o
 * accettare un margine di errore sul tempo reale trascorso durante il run.
 */
export function OfflineBanner({ lastSyncAt, now = Date.now }: { lastSyncAt: string | null; now?: () => number }) {
  const { t } = useTranslation();

  const text = (() => {
    if (!lastSyncAt) return t("mobile.common.offlineNoSync");
    const minutes = Math.max(0, Math.floor((now() - new Date(lastSyncAt).getTime()) / 60_000));
    if (minutes < 1) return t("mobile.common.offlineSyncedJustNow");
    return t("mobile.common.offlineSyncedMinutesAgo", { count: minutes });
  })();

  return (
    <View style={styles.pill}>
      <View style={styles.dot} />
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: "#b97d1a",
    borderRadius: 4,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  dot: {
    backgroundColor: colors.signal,
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  text: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
});
