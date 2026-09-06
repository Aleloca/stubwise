import { StatusBar } from "react-native";
import "../i18n";
import { AppProviders } from "./providers";
import { RootNavigator } from "./navigation";

/**
 * Radice dell'app (Task 13). Solo dark — `StatusBar` fissa
 * `barStyle="light-content"` invece di leggere `useColorScheme`: la fase 4
 * non ha un tema chiaro (vedi il design doc, §2), quindi non c'è nulla da
 * far scegliere al sistema.
 */
export default function App() {
  return (
    <AppProviders>
      <StatusBar barStyle="light-content" />
      <RootNavigator />
    </AppProviders>
  );
}
