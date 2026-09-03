import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { colors } from "../theme/tokens";
import { fontFamily } from "../theme/typography";

/**
 * `stubwise_`: il quadratino ambra prima del testo e il cursore `_` che
 * lampeggia sono nel canvas ovunque compaia il wordmark (login, header delle
 * schermate). Duty cycle preso dal `@keyframes blink` del canvas
 * (`0%,60% { opacity:1 } 61%,100% { opacity:0 }` su 1.1s): acceso 660ms,
 * spento 440ms, un taglio netto (`step-end`) e non una dissolvenza — per
 * questo `Animated.timing` con `duration: 0` e un `Animated.delay` a tenere
 * il valore, non un'interpolazione continua.
 */
export function Wordmark({ size = 24 }: { size?: number }) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // Sotto Jest un `Animated.loop` infinito tiene vivo il process (timer
    // che si riprogrammano da soli): Jest non esce mai da solo alla fine
    // della run ("did not exit one second after…", verificato — era la
    // causa di run bloccate per minuti su OGNI test che renderizza questo
    // componente, non solo i suoi). Il blink è un dettaglio visivo puro,
    // quindi sotto test resta semplicemente acceso.
    if (process.env?.JEST_WORKER_ID !== undefined) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 0, useNativeDriver: true }),
        Animated.delay(660),
        Animated.timing(opacity, { toValue: 0, duration: 0, useNativeDriver: true }),
        Animated.delay(440),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  const dotSize = Math.round(size * 0.62);

  return (
    <View style={styles.row}>
      <View style={[styles.dot, { width: dotSize, height: dotSize, marginRight: size * 0.28 }]} />
      <Text style={[styles.text, { fontSize: size }]}>
        stubwise
        <Animated.Text style={[styles.cursor, { opacity }]}>_</Animated.Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
    flexDirection: "row",
  },
  dot: {
    backgroundColor: colors.signal,
  },
  text: {
    color: colors.fg,
    fontFamily: fontFamily.monoSemiBold,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  cursor: {
    color: colors.signal,
  },
});
