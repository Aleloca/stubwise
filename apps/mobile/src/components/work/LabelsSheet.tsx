import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * I limiti che il SERVER impone alle etichette (`labelsSchema` in
 * `apps/server/src/routes/tickets.ts`: al massimo 20, ognuna da 1 a 50
 * caratteri). Ripetuti qui solo per dire PRIMA cosa non passerà, invece di
 * lasciar partire una richiesta che torna 400: l'autorità resta il server, e
 * se i due numeri divergessero l'errore del server arriverebbe comunque, già
 * mostrato da `usePatchTicket`.
 */
export const MAX_LABELS = 20;
export const MAX_LABEL_LENGTH = 50;

export interface LabelsSheetProps {
  visible: boolean;
  labels: readonly string[];
  /** L'elenco NUOVO, completo: la PATCH delle etichette sostituisce l'insieme. */
  onChange: (labels: string[]) => void;
  onRequestClose: () => void;
  disabled?: boolean;
}

/**
 * La modifica delle etichette di un ticket (23 set 2026): la quinta cosa che
 * il web modifica dal pannello del ticket (`LabelsEditor`,
 * `apps/web/src/components/labels-editor.tsx`), rimasta fuori dalla parità
 * del 21 settembre — vedi il §4.1 di
 * `docs/plans/2026-09-21-ticket-actions-parity-design.md`.
 *
 * Stesse regole del web: testo libero (non esiste un catalogo di etichette
 * da cui scegliere), spazi ai bordi tolti, un doppione IDENTICO non si
 * aggiunge. Una differenza voluta: il web scarta il doppione in silenzio,
 * qui lo si dice — su un telefono un tocco che non fa niente sembra un
 * guasto.
 *
 * A differenza delle altre quattro sheet dei campi, questa **resta aperta**
 * dopo ogni modifica: si aggiungono spesso più etichette di fila, e
 * richiuderla a ogni aggiunta costringerebbe a riaprirla ogni volta.
 *
 * Le etichette mostrate arrivano da `labels`, cioè dal ticket in cache — non
 * da una copia locale: dopo ogni salvataggio la cache si aggiorna e la sheet
 * mostra ciò che il server ha davvero salvato.
 */
export function LabelsSheet({ visible, labels, onChange, onRequestClose, disabled = false }: LabelsSheetProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const full = labels.length >= MAX_LABELS;

  function add(): void {
    const label = draft.trim();
    if (label === "") return;
    if (labels.includes(label)) {
      setNotice(t("mobile.work.fields.labelsDuplicate", { label }));
      return;
    }
    setNotice(null);
    setDraft("");
    onChange([...labels, label]);
  }

  function remove(label: string): void {
    setNotice(null);
    onChange(labels.filter((existing) => existing !== label));
  }

  function close(): void {
    // Una bozza o un avviso non devono sopravvivere alla chiusura: riaprendo
    // la sheet su un altro momento si ripartirebbe da un testo dimenticato.
    setDraft("");
    setNotice(null);
    onRequestClose();
  }

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={close} testID="ticket-field-labels-sheet">
      {/*
        ⚠️ La sheet è ancorata in BASSO e contiene un campo di testo: senza
        questo, su iOS la tastiera lo coprirebbe esattamente mentre si scrive.
      */}
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={t("mobile.work.fields.close")} />
        <Pressable style={styles.sheet} onPress={() => {}}>
          <Text style={styles.title}>{t("mobile.work.fields.labels")}</Text>

          {labels.length === 0 ? (
            <Text style={styles.empty} testID="ticket-field-labels-empty">
              {t("mobile.work.fields.labelsEmpty")}
            </Text>
          ) : (
            <ScrollView style={styles.chipsScroll} contentContainerStyle={styles.chips}>
              {labels.map((label) => (
                <Pressable
                  key={label}
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile.work.fields.labelsRemove", { label })}
                  accessibilityState={{ disabled }}
                  disabled={disabled}
                  onPress={() => remove(label)}
                  style={({ pressed }) => [styles.chip, pressed && !disabled && styles.pressed, disabled && styles.disabled]}
                  testID={`ticket-field-labels-remove-${label}`}
                >
                  <Text style={styles.chipText}>{label}</Text>
                  <Text style={styles.chipRemove}>×</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}

          {full ? (
            <Text style={styles.notice} testID="ticket-field-labels-full">
              {t("mobile.work.fields.labelsFull", { count: MAX_LABELS })}
            </Text>
          ) : (
            <View style={styles.addRow}>
              <TextInput
                value={draft}
                onChangeText={(text) => {
                  setDraft(text);
                  if (notice !== null) setNotice(null);
                }}
                onSubmitEditing={add}
                placeholder={t("mobile.work.fields.labelsPlaceholder")}
                placeholderTextColor={colors.faint}
                maxLength={MAX_LABEL_LENGTH}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                editable={!disabled}
                style={styles.input}
                testID="ticket-field-labels-input"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: disabled || draft.trim() === "" }}
                disabled={disabled || draft.trim() === ""}
                onPress={add}
                style={({ pressed }) => [
                  styles.addButton,
                  pressed && styles.pressed,
                  (disabled || draft.trim() === "") && styles.disabled,
                ]}
                testID="ticket-field-labels-add"
              >
                <Text style={styles.addButtonText}>{t("mobile.work.fields.labelsAdd")}</Text>
              </Pressable>
            </View>
          )}

          {notice !== null && (
            <Text accessibilityLiveRegion="polite" style={styles.notice} testID="ticket-field-labels-notice">
              {notice}
            </Text>
          )}
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    backgroundColor: "rgba(0,0,0,0.6)",
    flex: 1,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderTopLeftRadius: radii.card,
    borderTopRightRadius: radii.card,
    borderTopWidth: 1,
    maxHeight: "70%",
    paddingBottom: 32,
    paddingHorizontal: 16,
    paddingTop: 18,
  },
  title: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    marginBottom: 12,
    textTransform: "uppercase",
  },
  empty: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    marginBottom: 12,
  },
  chipsScroll: {
    flexGrow: 0,
    marginBottom: 12,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    alignItems: "center",
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chipText: {
    color: colors.fg,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  chipRemove: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
  },
  addRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  input: {
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    flex: 1,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.input,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  addButton: {
    borderColor: colors.signalDim,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  addButtonText: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  notice: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.label,
    marginTop: 10,
  },
  pressed: {
    opacity: 0.6,
  },
  disabled: {
    opacity: 0.5,
  },
});
