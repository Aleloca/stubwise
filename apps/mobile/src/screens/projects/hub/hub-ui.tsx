import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii } from "../../../theme/tokens";
import { fontFamily } from "../../../theme/typography";

/**
 * I MATTONI VISIVI DEL DETTAGLIO PROGETTO v3 (28 set 2026), ricreati dal
 * riferimento `docs/design/project-detail/Dettaglio Progetto v3.dc.html` coi
 * token dell'app: la scheda scura col bordo sottile, le righe separate da una
 * linea, le etichette mono maiuscole dei blocchi, il banner del monitor.
 */

/** La scheda che contiene le righe di un blocco. */
export function HubCard({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.card} testID={testID}>
      {children}
    </View>
  );
}

/**
 * Una riga di una scheda. `first` toglie la linea sopra: la prima riga non ne
 * ha, le altre sì (riferimento v3). Premibile solo con `onPress`.
 */
export function HubRow({
  children,
  first,
  onPress,
  testID,
  tall = false,
}: {
  children: ReactNode;
  first: boolean;
  onPress?: () => void;
  testID?: string;
  /** Le righe della tab Progetto: alte 48, senza padding verticale. */
  tall?: boolean;
}) {
  const style = [styles.row, tall && styles.rowTall, !first && styles.rowDivider];
  if (onPress === undefined) {
    return (
      <View style={style} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [...style, pressed && styles.rowPressed]}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

/** L'etichetta mono maiuscola sopra un blocco di Adesso («Tocca a te · 3»). */
export function HubBlockLabel({ text, amber = false }: { text: string; amber?: boolean }) {
  return <Text style={[styles.blockLabel, amber && styles.blockLabelAmber]}>{text}</Text>;
}

/**
 * Il titolo di un blocco della tab Lavoro: «Ticket» col conteggio in grigio e
 * «tutti ›» a destra, premibile verso la schermata intera.
 */
export function HubBlockHeader({
  title,
  count,
  seeAllLabel,
  onSeeAll,
  testID,
}: {
  title: string;
  count?: string;
  seeAllLabel: string;
  onSeeAll: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.blockHeader}>
      <Text style={styles.blockTitle}>
        {title}
        {count !== undefined && <Text style={styles.blockCount}>{` ${count}`}</Text>}
      </Text>
      <Pressable accessibilityRole="button" hitSlop={8} onPress={onSeeAll} testID={testID}>
        <Text style={styles.seeAll}>{seeAllLabel}</Text>
      </Pressable>
    </View>
  );
}

/** Il pallino colorato a sinistra di una riga («In esecuzione»). */
export function HubDot({ color }: { color: string }) {
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

/**
 * IL BANNER DEL MONITOR (design §4.1 e §7): bordo rosso, il server giù e
 * quanti controlli. Su Adesso porta alla tab Progetto, su Progetto al
 * Monitor: chi lo monta decide dove, qui c'è solo il disegno.
 *
 * `eyebrow` c'è solo su Adesso — sulla tab Progetto la riga del monitor sta
 * già sotto, e il riferimento v3 lì non la ripete.
 */
export function MonitorBanner({
  line,
  eyebrow,
  onPress,
  testID,
}: {
  line: string;
  eyebrow?: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={eyebrow !== undefined ? `${eyebrow}. ${line}` : line}
      onPress={onPress}
      style={({ pressed }) => [styles.banner, pressed && styles.rowPressed]}
      testID={testID}
    >
      <View style={[styles.dot, { backgroundColor: colors.danger }]} />
      <View style={styles.bannerText}>
        {eyebrow !== undefined && <Text style={styles.bannerEyebrow}>{eyebrow}</Text>}
        <Text style={styles.bannerLine} numberOfLines={2}>
          {line}
        </Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

export const hubText = StyleSheet.create({
  /** La riga mono grigia in testa a una voce («#27 · urgente · domanda»). */
  meta: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  /** Il titolo di una voce, su una riga sola. */
  title: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  /** Il testo mono a destra di una riga («12 min», «fermo 9g»). */
  trailing: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
});

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowTall: {
    minHeight: 48,
    paddingVertical: 0,
  },
  rowDivider: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  rowPressed: {
    backgroundColor: colors.ink850,
  },
  blockLabel: {
    color: colors.muted,
    fontFamily: fontFamily.monoMedium,
    fontSize: 12,
    fontWeight: "500",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  blockLabelAmber: {
    color: colors.signal,
  },
  blockHeader: {
    alignItems: "baseline",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  blockTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 17,
    fontWeight: "600",
  },
  blockCount: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontWeight: "400",
  },
  seeAll: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  dot: {
    borderRadius: 4,
    flexShrink: 0,
    height: 8,
    width: 8,
  },
  banner: {
    alignItems: "center",
    backgroundColor: colors.ink900,
    borderColor: colors.danger,
    borderRadius: radii.card,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  bannerText: {
    flex: 1,
    gap: 3,
    minWidth: 0,
  },
  bannerEyebrow: {
    color: colors.danger,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  bannerLine: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  chevron: {
    color: colors.muted,
    fontSize: 16,
  },
});
