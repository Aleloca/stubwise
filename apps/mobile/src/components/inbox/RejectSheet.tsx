import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SheetModal } from "../SheetModal";
import { GhostButton } from "../GhostButton";
import { PrimaryButton } from "../PrimaryButton";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

export interface RejectSheetProps {
  visible: boolean;
  onRequestClose: () => void;
  /** Riga di contesto sotto il titolo (canvas: "Piano: … — Progetto"): qui il `text` già localizzato della riga. */
  contextLine: string;
  onSubmit: (instructions: string | undefined) => void;
  pending: boolean;
  disabled: boolean;
  online: boolean;
  errorMessage: string | null;
  testID?: string;
}

/** Le 3 scorciatoie del canvas (`1e`): premerle inserisce la frase nel campo, non manda nulla da sole. */
const QUICK_CHIPS = [
  { key: "scope", i18nKey: "mobile.inbox.reject.chipScope" },
  { key: "cost", i18nKey: "mobile.inbox.reject.chipCost" },
  { key: "later", i18nKey: "mobile.inbox.reject.chipLater" },
] as const;

/**
 * Sheet di rifiuto di un piano (canvas `1e`): testo libero più chip rapide che
 * inseriscono una frase pronta nello stesso campo — "concatenate" vuol dire
 * proprio questo, un solo campo che chip e digitazione riempiono insieme.
 * `instructions` diventa un commento del team e il PROSSIMO piano ne tiene
 * conto (vedi `reject_plan` in `packages/notifications`); vuoto è un rifiuto
 * legittimo (nessuna istruzione), come sul web.
 */
export function RejectSheet({
  visible,
  onRequestClose,
  contextLine,
  onSubmit,
  pending,
  disabled,
  online,
  errorMessage,
  testID,
}: RejectSheetProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");

  useEffect(() => {
    if (visible) setText("");
  }, [visible]);

  function appendChip(label: string): void {
    setText((current) => {
      const trimmed = current.trim();
      if (trimmed.length === 0) return label;
      if (trimmed.includes(label)) return current;
      return `${trimmed}; ${label}`;
    });
  }

  function submit(): void {
    if (disabled) return;
    const trimmed = text.trim();
    onSubmit(trimmed.length > 0 ? trimmed : undefined);
  }

  return (
    <SheetModal open={visible} onClose={onRequestClose} testID={testID}>
      <Text style={styles.title}>{t("mobile.inbox.reject.title")}</Text>
      <Text style={styles.context}>{contextLine}</Text>

      <TextInput
        accessibilityLabel={t("mobile.inbox.reject.title")}
        value={text}
        onChangeText={setText}
        editable={!disabled}
        multiline
        placeholder={t("mobile.inbox.reject.placeholder")}
        placeholderTextColor={colors.faint}
        style={styles.input}
        testID="reject-sheet-input"
      />

      <View style={styles.chipRow}>
        {QUICK_CHIPS.map((chip) => {
          const label = t(chip.i18nKey);
          return (
            <Pressable
              key={chip.key}
              accessibilityRole="button"
              onPress={() => appendChip(label)}
              style={styles.chip}
              testID={`reject-sheet-chip-${chip.key}`}
            >
              <Text style={styles.chipLabel}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      {!online && <Text style={styles.offlineNotice}>{t("mobile.inbox.offlineAction")}</Text>}
      {errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {errorMessage}
        </Text>
      )}

      <View style={styles.actions}>
        <View style={styles.primaryButton}>
          <PrimaryButton
            label={online ? t("mobile.inbox.reject.submit") : t("mobile.inbox.offlineAction")}
            onPress={submit}
            disabled={disabled || pending}
            testID="reject-sheet-submit"
          />
        </View>
        <View style={styles.secondaryButton}>
          <GhostButton besidePrimary label={t("mobile.inbox.reject.cancel")} onPress={onRequestClose} testID="reject-sheet-cancel" />
        </View>
      </View>

      <Text style={styles.hint}>{t("mobile.inbox.reject.hint")}</Text>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  title: {
    color: colors.fg,
    fontFamily: fontFamily.sansBold,
    fontSize: 18,
    fontWeight: "700",
  },
  context: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 4,
  },
  input: {
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: colors.signalDim,
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.input,
    marginTop: 14,
    minHeight: 88,
    padding: 14,
    textAlignVertical: "top",
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 10,
  },
  chip: {
    borderColor: colors.lineStrong,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  offlineNotice: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginTop: 12,
  },
  errorText: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    marginTop: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 14,
  },
  primaryButton: {
    flex: 2,
  },
  secondaryButton: {
    flex: 1,
  },
  hint: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginTop: 12,
  },
});
