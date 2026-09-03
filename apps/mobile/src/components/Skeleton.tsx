import type { DimensionValue } from "react-native";
import { StyleSheet, View } from "react-native";
import { colors, radii } from "../theme/tokens";

/**
 * Rettangolo placeholder STATICO — niente shimmer. È una scelta del canvas,
 * non una dimenticanza: «Niente: skeleton animati, parallax, transizioni
 * decorative. La latenza AI si comunica con le parole («ti avviso io»), non
 * col movimento.» (note per gli sviluppatori, canvas). Un'animazione qui
 * sarebbe in contraddizione diretta con quella riga.
 */
export function Skeleton({
  width = "100%",
  height = 12,
  radius = radii.control,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
}) {
  return <View style={[styles.base, { width, height, borderRadius: radius }]} />;
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.ink800,
  },
});
