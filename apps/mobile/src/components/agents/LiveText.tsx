import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { LIVE_THROTTLE_MS, LONG_TEXT_CHARS, liveTail } from "../../lib/transcript-text";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { SafeMarkdown } from "../SafeMarkdown";

/**
 * Il valore più recente, ma al più uno ogni `ms`: il primo cambiamento dopo
 * una pausa passa subito, quelli dentro la finestra aspettano la sua fine e
 * vince l'ULTIMO (mai un pezzo intermedio rimasto a schermo).
 */
function useThrottledValue<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const lastAt = useRef(0);
  useEffect(() => {
    const wait = lastAt.current + ms - Date.now();
    if (wait <= 0) {
      lastAt.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      lastAt.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return shown;
}

/**
 * Il testo dell'agente mentre lo scrive (19 ott 2026, vedi il docblock di
 * `lib/transcript-text.ts`): markdown come il messaggio completo, così non
 * cambia aspetto a fine turno, e intero dall'inizio, così chi lo sta leggendo
 * non se lo vede sparire da sopra. Il costo del markdown lo tiene basso il
 * ridisegno limitato ({@link LIVE_THROTTLE_MS}); oltre {@link LONG_TEXT_CHARS}
 * il testo è semplice, e solo oltre `LIVE_TAIL_CHARS` (un documento Docs) se
 * ne mostra la coda.
 */
export function LiveText({ id, text }: { id: string; text: string }) {
  const shown = useThrottledValue(text, LIVE_THROTTLE_MS);
  let body;
  if (shown.length <= LONG_TEXT_CHARS) {
    body = <SafeMarkdown>{shown}</SafeMarkdown>;
  } else {
    const tail = liveTail(shown);
    body = <Text style={styles.plain}>{tail.cut ? `…${tail.text}` : tail.text}</Text>;
  }
  return (
    <View testID={`transcript-live-${id}`}>
      {body}
      <View style={styles.cursor} />
    </View>
  );
}

const styles = StyleSheet.create({
  cursor: { backgroundColor: colors.muted, height: 12, marginTop: 2, opacity: 0.7, width: 6 },
  plain: { color: colors.fg, fontFamily: fontFamily.sans, fontSize: fontSize.body },
});
