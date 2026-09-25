import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/**
 * WISEY («Wisey, anteprima nell'app», 25 set 2026). Per ora un SEGNAPOSTO:
 * il Task 1 esiste per vedere sul telefono il gufo nella barra nativa col
 * Liquid Glass (design §2, il rischio da verificare per primo). La schermata
 * vera — gufo animato, messaggi, campo — arriva col Task 5.
 */
export function WiseyScreen() {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="wisey-screen">
      <View style={styles.header}>
        <ScreenHeader title={t("mobile.wisey.title")} />
      </View>
      <Text style={styles.placeholder}>{t("mobile.wisey.placeholder")}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  header: {
    padding: 16,
  },
  placeholder: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 13,
    paddingHorizontal: 32,
    paddingTop: 48,
    textAlign: "center",
  },
});
