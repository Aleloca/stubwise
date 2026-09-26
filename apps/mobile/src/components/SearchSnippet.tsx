import { searchSnippetSegments } from "@stubwise/shared";
import { StyleSheet, Text, type StyleProp, type TextStyle } from "react-native";
import { colors } from "../theme/tokens";
import { fontFamily } from "../theme/typography";

/**
 * L'ESTRATTO di un risultato di ricerca, con in grassetto il pezzo che ha
 * fatto comparire il risultato — lo stesso in ogni punto dell'app (26 set
 * 2026: estratto da `GlobalSearchSheet`, dove viveva come `SnippetText`,
 * perché le ricerche della documentazione stampavano lo snippet crudo).
 *
 * Lo `snippet` porta i marcatori **`<b>`** di `ts_headline` più il markdown del
 * corpo da cui è ritagliato. `searchSnippetSegments` (`@stubwise/shared`)
 * toglie entrambi e dice quale pezzo era marcato. `<Text>` di React Native non
 * interpreta markup, quindi non c'è niente da escapare e non si apre nessuna
 * strada di rendering nuova.
 *
 * Il grassetto NON è decorazione: in un elenco dice perché quella riga è lì,
 * soprattutto quando il termine cercato è sepolto nell'estratto.
 */
export function SearchSnippet({
  snippet,
  style,
  numberOfLines = 2,
  testID,
}: {
  snippet: string | null;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  testID?: string;
}) {
  if (snippet === null || snippet === "") return null;
  const segments = searchSnippetSegments(snippet);
  if (segments.length === 0) return null;
  let match = 0;
  return (
    <Text style={[styles.snippet, style]} numberOfLines={numberOfLines} testID={testID}>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <Text key={index} style={styles.match} testID={testID ? `${testID}-match-${match++}` : undefined}>
            {segment.text}
          </Text>
        ) : (
          <Text key={index}>{segment.text}</Text>
        ),
      )}
    </Text>
  );
}

const styles = StyleSheet.create({
  snippet: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
  },
  /**
   * Il pezzo che ha combaciato. Peso E colore: l'estratto è `colors.muted`, e
   * su un fondo scuro il solo grassetto si distingue poco — portare la parola
   * trovata al colore del testo pieno la stacca senza aggiungere un accento
   * che competerebbe con `colors.signal`, che in questa app vuol dire «serve
   * una tua decisione».
   */
  match: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontWeight: "600",
  },
});
