import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { useRequestCorrection } from "../../lib/correction-mutations";
import { GhostButton } from "../GhostButton";
import { PrimaryButton } from "../PrimaryButton";
import { SheetModal } from "../SheetModal";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Lo stesso tetto di `requestCorrectionBodySchema` lato server (e del web). */
const NOTE_MAX = 4000;

/** La mutazione di F3, così com'è: il pannello la usa, non la ricrea. */
export type CorrectionRequest = ReturnType<typeof useRequestCorrection>;

/** La PR su cui si chiede la correzione: una per repository. */
export interface CorrectionTarget {
  repositoryId: string;
  repositoryName: string;
}

export interface CorrectionSheetProps {
  /** `null` = pannello chiuso. */
  target: CorrectionTarget | null;
  /**
   * L'IDENTITÀ del ticket, che lega la nota al ticket giusto: il numero è per
   * progetto (`tickets_project_id_number_unique`), e due progetti che
   * condividono un repository possono avere lo stesso numero.
   */
  ticketId: string;
  /** Solo per il titolo. */
  ticketNumber: number;
  /**
   * Di chi monta il pannello (la sezione PR, F5): lì serve anche a spegnere il
   * bottone che lo apre mentre una richiesta è in volo.
   */
  correction: CorrectionRequest;
  /**
   * Chi monta il pannello lo chiude (`target` a `null`), e basta: `reset()` e
   * la guardia sull'invio in volo stanno qui dentro.
   *
   * ⚠️ Deve essere IDEMPOTENTE: dopo un successo arriva due volte — dall'`onDone`
   * della mutazione e poi da `onDidDismiss` del foglio, che si chiude perché
   * `target` è tornato `null`.
   */
  onClose: () => void;
}

/**
 * «CHIEDI MODIFICHE» (30 set 2026, design «correzioni post-PR» §9): una
 * nota FACOLTATIVA e la conferma, gemello di `pr-cycle-row.tsx` del web. Sta
 * nel foglio nativo come tutte le finestre dell'app dal 25 set; il campo di
 * testo NON va avvolto in un `KeyboardAvoidingView` (lo spostamento lo fa
 * true-sheet — vedi il docblock di `SheetModal`).
 *
 * Come `MergeSheet`: l'errore resta dentro il pannello, che si chiude SOLO al
 * successo (l'`onDone` della mutazione); mentre la richiesta è in volo non si
 * manda via né col dito né con «Annulla» — l'esito arriverebbe su una finestra
 * che non c'è più. «Annulla» e la chiusura col dito azzerano la mutazione
 * (`reset()`): riaprendo non si ritrova l'errore di prima.
 *
 * La nota è stato LOCALE del modulo interno, che si monta solo a pannello
 * aperto ed è keyato su `ticketId` e repository (mai sul NUMERO del ticket,
 * che è per progetto): chiudere la butta via, e passare
 * a un'altra PR — anche senza chiudere — la riparte vuota. Il mock di
 * true-sheet in Jest smonta già i figli alla chiusura, il foglio vero non è
 * detto: per questo l'azzeramento non si affida al contenitore.
 */
export function CorrectionSheet({ target, ticketId, ticketNumber, correction, onClose }: CorrectionSheetProps) {
  const pending = correction.isPending;
  const { reset } = correction;

  // All'APERTURA (`target` da `null` a un valore) la mutazione riparte pulita.
  // Serve per l'unico caso che la chiusura non copre: il pannello chiuso DA
  // CODICE mentre la richiesta è in volo (lì `close` non azzera, per non
  // perderne l'esito), e la richiesta che poi fallisce — senza questo,
  // riaprendo si ritroverebbe quell'errore. Non a richiesta in volo: azzerare
  // allora riaccenderebbe i bottoni su un invio ancora in corso.
  const wasOpen = useRef(false);
  useEffect(() => {
    const isOpen = target !== null;
    if (isOpen && !wasOpen.current && !pending) reset();
    wasOpen.current = isOpen;
  }, [target, pending, reset]);

  function close(): void {
    if (pending) return;
    correction.reset();
    onClose();
  }

  return (
    <SheetModal open={target !== null} onClose={close} dismissible={!pending} testID="correction-sheet">
      {target !== null && (
        <CorrectionForm
          key={`${ticketId}:${target.repositoryId}`}
          target={target}
          ticketNumber={ticketNumber}
          correction={correction}
          onCancel={close}
          onDone={onClose}
        />
      )}
    </SheetModal>
  );
}

function CorrectionForm({
  target,
  ticketNumber,
  correction,
  onCancel,
  onDone,
}: {
  target: CorrectionTarget;
  ticketNumber: number;
  correction: CorrectionRequest;
  onCancel: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");
  const { isPending: pending, online, errorMessage } = correction;

  function confirm(): void {
    if (correction.disabled) return;
    const trimmed = note.trim();
    correction.request({ repositoryId: target.repositoryId, note: trimmed.length > 0 ? trimmed : undefined }, onDone);
  }

  return (
    <View>
      <Text accessibilityRole="header" style={styles.title}>{t("mobile.work.pr.sheet.title", { number: ticketNumber })}</Text>
      <Text style={styles.context}>{target.repositoryName}</Text>
      <Text style={styles.body}>{t("mobile.work.pr.sheet.body")}</Text>

      <Text style={styles.label}>{t("mobile.work.pr.sheet.noteLabel")}</Text>
      <TextInput
        accessibilityLabel={t("mobile.work.pr.sheet.noteLabel")}
        value={note}
        onChangeText={setNote}
        editable={!pending}
        multiline
        maxLength={NOTE_MAX}
        placeholder={t("mobile.work.pr.sheet.placeholder")}
        placeholderTextColor={colors.faint}
        style={styles.input}
        testID="correction-sheet-note"
      />

      {!online && <Text style={styles.offline}>{t("mobile.work.pr.sheet.offline")}</Text>}
      {errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.error} testID="correction-sheet-error">
          {errorMessage}
        </Text>
      )}

      <View style={styles.actions}>
        <View style={styles.primary}>
          <PrimaryButton
            label={t("mobile.work.pr.sheet.confirm")}
            onPress={confirm}
            pending={pending}
            disabled={!online}
            testID="correction-sheet-confirm"
          />
        </View>
        <View style={styles.secondary}>
          <GhostButton
            besidePrimary
            label={t("mobile.work.pr.sheet.cancel")}
            onPress={onCancel}
            disabled={pending}
            testID="correction-sheet-cancel"
          />
        </View>
      </View>
    </View>
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
  body: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    lineHeight: 20,
    marginTop: 10,
  },
  label: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 14,
  },
  input: {
    backgroundColor: "rgba(10,13,16,0.7)",
    borderColor: colors.signalDim,
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.input,
    marginTop: 6,
    minHeight: 88,
    padding: 14,
    textAlignVertical: "top",
  },
  offline: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    marginTop: 12,
  },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    marginTop: 12,
  },
  actions: {
    flexDirection: "row",
    gap: 10,
    marginTop: 16,
  },
  primary: {
    flex: 2,
  },
  secondary: {
    flex: 1,
  },
});
