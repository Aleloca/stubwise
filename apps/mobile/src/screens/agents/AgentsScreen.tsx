import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { ScreenHeader } from "../../components/ScreenHeader";
import { colors } from "../../theme/tokens";

/**
 * LA TAB AGT (sessioni degli agenti, piano C, design §8.1): prende il posto
 * di MBX nella barra. In questo task è solo un SEGNAPOSTO col titolo — la
 * schermata esiste perché la tab e il deep link `stubwise://agents` abbiano
 * dove atterrare; il contenuto (le sessioni al lavoro e le concluse) è il
 * Task 5.
 */
export function AgentsScreen() {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="agents-screen">
      <ScreenHeader title={t("mobile.tabs.agents")} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
    padding: 16,
  },
});
