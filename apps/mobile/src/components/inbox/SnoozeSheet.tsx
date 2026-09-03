import type { SnoozeUntil } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
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
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onRequestClose} testID={testID}>
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onRequestClose}
          accessibilityLabel={t("mobile.inbox.actions.cancel")}
        />
        <Pressable style={styles.sheet} onPress={() => {}}>
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
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(5,7,10,0.7)",
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    padding: 20,
    paddingBottom: 32,
  },
  title: {
    color: colors.fg,
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
    borderColor: "#2c3641",
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
