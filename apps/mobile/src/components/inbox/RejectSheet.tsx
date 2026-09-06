import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
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
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onRequestClose} testID={testID}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onRequestClose} accessibilityLabel={t("mobile.inbox.reject.cancel")} />
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <ScrollView keyboardShouldPersistTaps="handled">
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
                <GhostButton label={t("mobile.inbox.reject.cancel")} onPress={onRequestClose} testID="reject-sheet-cancel" />
              </View>
            </View>

            <Text style={styles.hint}>{t("mobile.inbox.reject.hint")}</Text>
          </ScrollView>
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
    maxHeight: "85%",
    paddingBottom: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  handle: {
    alignSelf: "center",
    backgroundColor: "#2c3641",
    borderRadius: 2,
    height: 4,
    marginBottom: 16,
    width: 36,
  },
  title: {
    color: colors.fg,
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
    borderColor: "#b97d1a",
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
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
    borderColor: "#2c3641",
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
