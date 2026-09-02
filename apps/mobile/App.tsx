/**
 * App minimale della Fase 4: serve solo a dimostrare che Metro risolve un
 * package workspace pnpm (@stubwise/shared, un symlink in node_modules).
 * Le schermate vere arrivano nei task successivi.
 *
 * @format
 */

import { ticketStatusSchema } from "@stubwise/shared";
import { StatusBar, StyleSheet, Text, View, useColorScheme } from "react-native";

function App() {
  const isDarkMode = useColorScheme() === "dark";

  return (
    <View style={styles.container}>
      <StatusBar barStyle={isDarkMode ? "light-content" : "dark-content"} />
      <Text style={styles.label}>Stati ticket da @stubwise/shared</Text>
      <Text style={styles.count}>{ticketStatusSchema.options.length}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
  },
  label: {
    fontSize: 16,
  },
  count: {
    fontSize: 64,
    fontWeight: "bold",
  },
});

export default App;
