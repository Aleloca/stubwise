import { Linking, StyleSheet, Text } from "react-native";
import type { StyleProp, TextStyle } from "react-native";
import { isOpenableUrl, linkify } from "../lib/linkify";
import { colors } from "../theme/tokens";

/**
 * Un testo NON FIDATO in cui gli indirizzi sono toccabili (App, 13 set
 * 2026): il corpo di un'email, dove il link è spesso il motivo per cui il
 * messaggio è stato mandato.
 *
 * Il taglio in pezzi sta in `linkify` (funzione pura, testata a parte);
 * qui resta solo la resa. `isOpenableUrl` è ricontrollato PRIMA di aprire
 * anche se `linkify` produce già solo `http`/`https`: è difesa in
 * profondità, non ridondanza — il giorno in cui qualcuno allargasse la
 * regex, questo controllo è ciò che tiene `Linking.openURL` lontano da uno
 * schema arbitrario.
 */
export function LinkedText({
  text,
  style,
  testID,
}: {
  text: string;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  return (
    <Text style={style} testID={testID}>
      {linkify(text).map((segment, index) =>
        segment.kind === "link" ? (
          <Text
            key={index}
            accessibilityRole="link"
            onPress={() => {
              if (isOpenableUrl(segment.url)) void Linking.openURL(segment.url);
            }}
            style={styles.link}
          >
            {segment.text}
          </Text>
        ) : (
          segment.text
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  link: {
    color: colors.signal,
    textDecorationLine: "underline",
  },
});
