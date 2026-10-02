import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

export interface HubTab<K extends string> {
  key: K;
  label: string;
  /** Il numero ambra accanto all'etichetta; non compare a zero né assente. */
  badge?: number;
  badgeLabel?: string;
  /** Il pallino rosso: qualcosa di rotto dietro quella tab. */
  alert?: boolean;
  alertLabel?: string;
  /**
   * Il pallino AMBRA: dietro quella tab serve un'azione di chi guarda (pagina
   * del ticket a tab, 2 ott 2026). Diverso dal rosso di `alert`, che dice
   * «qualcosa è rotto». Compare solo con `true`.
   */
  dot?: boolean;
  dotLabel?: string;
  /**
   * Un contatore NEUTRO accanto all'etichetta (i commenti di Attività): non è
   * il `badge` ambra, non chiede niente. Compare ogni volta che è un numero,
   * anche 0: se mostrarlo lo decide il chiamante (assente = non lo so).
   */
  count?: number;
  countLabel?: string;
}

/**
 * LE TAB DEL DETTAGLIO PROGETTO v3 (28 set 2026, design §3): mono maiuscolo,
 * a tutta larghezza, la attiva sottolineata in ambra — come nel riferimento
 * `docs/design/project-detail/Dettaglio Progetto v3.dc.html`.
 *
 * Non è una tab bar di navigazione: le tre tab sono viste della STESSA
 * schermata, e la scelta vive nello stato di chi la monta — così resta
 * finché la schermata è montata, e tornando da un ticket si ritrova quella di
 * prima.
 */
export function HubTabBar<K extends string>({
  tabs,
  active,
  onSelect,
  testIDPrefix = "hub-tab",
}: {
  tabs: readonly HubTab<K>[];
  active: K;
  onSelect: (key: K) => void;
  /** Prefisso dei testID (`<prefisso>-<chiave>`); il default è quello del dettaglio progetto. */
  testIDPrefix?: string;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.row}>
      {tabs.map((tab) => {
        const selected = tab.key === active;
        const showBadge = tab.badge !== undefined && tab.badge > 0;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onSelect(tab.key)}
            style={[styles.tab, selected && styles.tabSelected]}
            testID={`${testIDPrefix}-${tab.key}`}
          >
            <Text numberOfLines={1} style={[styles.label, selected && styles.labelSelected]}>
              {tab.label}
            </Text>
            {tab.count !== undefined && (
              <View
                accessibilityLabel={tab.countLabel}
                style={styles.count}
                testID={`${testIDPrefix}-${tab.key}-count`}
              >
                <Text style={styles.countText}>{tab.count}</Text>
              </View>
            )}
            {showBadge && (
              <View
                accessibilityLabel={tab.badgeLabel}
                style={styles.badge}
                testID={`${testIDPrefix}-${tab.key}-badge`}
              >
                <Text style={styles.badgeText}>{tab.badge}</Text>
              </View>
            )}
            {tab.alert === true && (
              <View accessibilityLabel={tab.alertLabel} style={styles.alert} testID={`${testIDPrefix}-${tab.key}-alert`} />
            )}
            {tab.dot === true && (
              <View accessibilityLabel={tab.dotLabel} style={styles.dot} testID={`${testIDPrefix}-${tab.key}-dot`} />
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    gap: 4,
    paddingHorizontal: 20,
  },
  tab: {
    alignItems: "center",
    borderBottomColor: "transparent",
    borderBottomWidth: 2,
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 44,
  },
  tabSelected: {
    borderBottomColor: colors.signal,
  },
  label: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  labelSelected: {
    color: colors.fg,
  },
  badge: {
    backgroundColor: colors.signal,
    borderRadius: 8,
    paddingHorizontal: 6,
  },
  badgeText: {
    color: colors.ink950,
    fontFamily: fontFamily.monoMedium,
    fontSize: 11,
    fontWeight: "500",
  },
  alert: {
    backgroundColor: colors.danger,
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  dot: {
    backgroundColor: colors.signal,
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  count: {
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 5,
  },
  countText: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
});
