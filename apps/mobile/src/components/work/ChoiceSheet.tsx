import { Pressable, StyleSheet, Text, View } from "react-native";
import { SheetModal } from "../SheetModal";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export interface Choice {
  /** `null` è una scelta legittima: "nessun assegnatario", "nessuna milestone". */
  value: string | null;
  label: string;
}

export interface ChoiceSheetProps {
  visible: boolean;
  title: string;
  choices: Choice[];
  /** Il valore corrente: la riga corrispondente porta il segno di spunta. */
  selected: string | null;
  onChoose: (value: string | null) => void;
  onRequestClose: () => void;
  disabled?: boolean;
  testIDPrefix: string;
}

/**
 * Scelta singola in una sheet modale: una riga per opzione, un tap sceglie e
 * chiude. È il selettore dei campi di un ticket (stato, priorità,
 * assegnatario, milestone) — su un telefono non esiste il menu a tendina del
 * web, e una fila di bottoni non regge un elenco di persone.
 *
 * Il valore scelto viaggia com'è, `null` compreso: azzerare un assegnatario è
 * una scelta, non l'assenza di una scelta, e il server distingue i due casi
 * (campo assente = non toccare, `null` = azzera).
 *
 * La lista SCORRE (le milestone di un progetto e le persone di
 * un'istanza non hanno un tetto), ma lo scorrimento è quello del pannello
 * (`SheetModal`), non uno suo: dentro il foglio nativo ce ne deve essere
 * uno solo, perché è su quello che il sistema coordina il gesto di chiusura.
 */
export function ChoiceSheet({
  visible,
  title,
  choices,
  selected,
  onChoose,
  onRequestClose,
  disabled = false,
  testIDPrefix,
}: ChoiceSheetProps) {
  return (
    <SheetModal open={visible} onClose={onRequestClose} testID={testIDPrefix}>
      <Text style={styles.title}>{title}</Text>
      <View>
        {choices.map((choice) => {
          const isSelected = choice.value === selected;
          return (
            <Pressable
              key={choice.value ?? "__none__"}
              accessibilityRole="button"
              accessibilityState={{ disabled, selected: isSelected }}
              disabled={disabled}
              onPress={() => onChoose(choice.value)}
              style={({ pressed }) => [
                styles.row,
                pressed && !disabled && styles.pressed,
                disabled && styles.disabled,
              ]}
              testID={`${testIDPrefix}-${choice.value ?? "none"}`}
            >
              <Text style={[styles.rowLabel, isSelected && styles.rowLabelSelected]}>{choice.label}</Text>
              {isSelected && <Text style={styles.check}>✓</Text>}
            </Pressable>
          );
        })}
      </View>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  title: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    marginBottom: 12,
    textTransform: "uppercase",
  },
  row: {
    alignItems: "center",
    borderRadius: radii.control,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 14,
  },
  pressed: {
    backgroundColor: colors.ink850,
  },
  disabled: {
    opacity: 0.5,
  },
  rowLabel: {
    color: colors.muted,
    flex: 1,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
  },
  rowLabelSelected: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
  },
  check: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
  },
});
