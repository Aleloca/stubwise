import type { SnoozeUntil } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SheetModal } from "../SheetModal";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

export interface SnoozeSheetProps {
  visible: boolean;
  onRequestClose: () => void;
  onChoose: (until: SnoozeUntil) => void;
  disabled?: boolean;
  testID?: string;
}

/**
 * Le etichette del canvas («1h / stasera / domani», nota implementativa
 * "Snooze") NON coincidono 1:1 coi valori dell'API (`1h`/`tomorrow`/`3d`): è
 * una mappatura label→value voluta dal canvas, non un valore nuovo — vedi la
 * nota del Task 14. "Stasera" invia `tomorrow`, "Domani" invia `3d`.
 */
const SNOOZE_OPTIONS: { until: SnoozeUntil; i18nKey: string }[] = [
  { until: "1h", i18nKey: "mobile.inbox.snooze.oneHour" },
  { until: "tomorrow", i18nKey: "mobile.inbox.snooze.tonight" },
  { until: "3d", i18nKey: "mobile.inbox.snooze.tomorrow" },
];

/** Sheet minimale di rinvio: tre opzioni, un tap sceglie e chiude. */
export function SnoozeSheet({ visible, onRequestClose, onChoose, disabled = false, testID }: SnoozeSheetProps) {
  const { t } = useTranslation();

  return (
    <SheetModal open={visible} onClose={onRequestClose} testID={testID} scrollable={false}>
      <Text style={styles.title}>{t("mobile.inbox.snooze.title")}</Text>
      <View style={styles.row}>
        {SNOOZE_OPTIONS.map((option) => (
          <Pressable
            key={option.until}
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => onChoose(option.until)}
            style={({ pressed }) => [styles.option, pressed && !disabled && styles.pressed, disabled && styles.disabled]}
            testID={`snooze-sheet-${option.until}`}
          >
            <Text style={styles.optionLabel}>{t(option.i18nKey)}</Text>
          </Pressable>
        ))}
      </View>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  title: {
    color: colors.fg,
    fontFamily: fontFamily.sansBold,
    fontSize: 16,
    fontWeight: "700",
    marginBottom: 12,
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  option: {
    alignItems: "center",
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 48,
  },
  pressed: {
    opacity: 0.7,
  },
  disabled: {
    opacity: 0.4,
  },
  optionLabel: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: 13,
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
});
