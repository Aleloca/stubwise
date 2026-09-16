import type { Reader, SessionUser } from "@stubwise/shared";
import { isUnknown } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { SETTINGS_GROUPS, type SettingsSection, type SettingsSectionKey } from "./sections";

export interface SettingsScreenProps {
  user: Reader<SessionUser>;
  /** Apre una sotto-pagina: la rotta è UNA sola, parametrica (vedi `sections.ts`). */
  onOpenSection: (key: SettingsSectionKey) => void;
  onBack: () => void;
  /** Esce: il logout vero vive nella pagina di sezione «Profilo»? No — resta qui, vedi sotto. */
  onLogout: () => void;
  loggingOut: boolean;
  testID?: string;
}

/**
 * INDICE delle Impostazioni (16 set 2026): gruppi di righe che aprono una
 * sotto-pagina.
 *
 * La forma è una decisione del maintainer, presa sapendo che qui finiranno
 * TUTTE le impostazioni future. Fino a oggi era prima uno sheet dal basso, poi
 * una pagina unica a sezioni: entrambe reggevano finché le voci erano quattro.
 *
 * **«Esci» resta sull'indice**, non dentro «Profilo»: è l'unica azione della
 * pagina che non è un'impostazione, ed è quella che si cerca con più fretta.
 * Sepolta in una sotto-pagina sarebbe due tap invece di uno, e nessuno la
 * cerca lì.
 *
 * ⚠️ L'indice NON interroga la rete per riempire le righe. Il valore a destra
 * si mostra solo dove è già noto senza chiedere niente a nessuno (l'indirizzo
 * dell'utente, che arriva dalla sessione): mettere «Attive»/«Disattivate»
 * accanto alle notifiche costerebbe una query per disegnare un'etichetta, e
 * un indice che carica è un indice che sfarfalla.
 */
export function SettingsScreen({
  user,
  onOpenSection,
  onBack,
  onLogout,
  loggingOut,
  testID,
}: SettingsScreenProps) {
  const { t } = useTranslation();
  const roleKey = !isUnknown(user.role) && user.role === "admin" ? "admin" : "member";

  return (
    <View style={styles.container} testID={testID}>
      <ScrollView contentContainerStyle={styles.body} stickyHeaderIndices={[0]}>
        {/* `showAvatar={false}`: l'avatar è il bottone che porta qui. */}
        <ScreenHeader
          title={t("mobile.settings.title")}
          onBack={onBack}
          backLabel={t("mobile.settings.back")}
          showAvatar={false}
        />

        <View style={styles.profileRow}>
          <Text style={styles.email} numberOfLines={1}>
            {user.email}
          </Text>
          <View style={styles.roleBadge}>
            <Text style={styles.roleBadgeText}>{t(`mobile.settings.role.${roleKey}`)}</Text>
          </View>
        </View>

        {SETTINGS_GROUPS.map((group) => (
          <View key={group.labelKey} style={styles.group}>
            <SectionLabel style={styles.groupLabel}>{t(group.labelKey)}</SectionLabel>
            <View style={styles.card}>
              {group.sections.map((item, index) => (
                <SettingsRow
                  key={item.key}
                  section={item}
                  first={index === 0}
                  onPress={() => onOpenSection(item.key)}
                />
              ))}
            </View>
          </View>
        ))}

        <View style={styles.logoutWrap}>
          <GhostButton
            label={loggingOut ? t("mobile.settings.loggingOut") : t("mobile.settings.logout")}
            onPress={onLogout}
            disabled={loggingOut}
            testID="settings-logout-button"
          />
        </View>
      </ScrollView>
    </View>
  );
}

function SettingsRow({
  section,
  first,
  onPress,
}: {
  section: SettingsSection;
  first: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.row, !first && styles.rowDivided]}
      testID={`settings-row-${section.key}`}
    >
      <Text style={styles.rowLabel} numberOfLines={1}>
        {t(section.labelKey)}
      </Text>
      {section.status === "wip" && (
        <View style={styles.wipBadge}>
          <Text style={styles.wipBadgeText}>{t("mobile.settings.wipBadge")}</Text>
        </View>
      )}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    paddingBottom: 48,
  },
  profileRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    paddingBottom: 8,
    paddingHorizontal: 20,
  },
  email: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
  },
  roleBadge: {
    backgroundColor: colors.ink800,
    borderRadius: radii.control,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  roleBadgeText: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  group: {
    marginTop: 22,
    paddingHorizontal: 20,
  },
  groupLabel: {
    marginBottom: 8,
  },
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    overflow: "hidden",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  rowDivided: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  rowLabel: {
    color: colors.fg,
    flex: 1,
    fontFamily: fontFamily.sans,
    fontSize: 15,
  },
  wipBadge: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  wipBadgeText: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 0.6,
  },
  chevron: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 20,
  },
  logoutWrap: {
    alignItems: "center",
    marginTop: 32,
    paddingHorizontal: 20,
  },
});
