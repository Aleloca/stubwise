import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text } from "react-native";
import { useAuth } from "../app/providers";
import { colors } from "../theme/tokens";
import { fontFamily } from "../theme/typography";

/**
 * L'avatar (cerchio con l'iniziale dell'email) → apre le Impostazioni.
 * Estratto da `ScreenHeader.tsx` nel fix di review dell'11 set 2026
 * (`docs/plans/2026-09-11-app-m1-m2-review-fixes-plan.md`, Task 2): prima
 * viveva SOLO dentro `ScreenHeader`, quindi mancava del tutto sulle
 * schermate che non lo usano (dettaglio/lavoro/le due chat) — una
 * regressione rispetto a `main`, dove l'avatar viveva nella barra globale e
 * c'era OVUNQUE. Ora è un pezzo a sé, riusato sia da `ScreenHeader` sia
 * dall'header "indietro" di ogni schermata di dettaglio: un solo posto dove
 * l'avatar sa come aprirsi, non una copia per schermata.
 */
export function SettingsAvatarButton() {
  const { t } = useTranslation();
  const { user, openSettings } = useAuth();
  const avatarInitial = user !== null ? user.email.charAt(0).toUpperCase() : "";

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("mobile.settings.openLabel")}
      onPress={openSettings}
      style={styles.avatarButton}
      testID="settings-avatar-button"
    >
      <Text style={styles.avatarLabel}>{avatarInitial}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
