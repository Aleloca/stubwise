import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useDeleteDesign, useDeletePlan } from "../../lib/work-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Quale cancellazione sta chiedendo conferma; `null` = nessuna. */
type Pending = "design" | "plan" | null;

export interface DestructiveActionsProps {
  ticketId: string;
  /** Senza un design collegato non c'è niente da scollegare: il bottone non compare. */
  hasDesign: boolean;
  /** Idem per il piano. */
  hasPlan: boolean;
}

/**
 * Le due cancellazioni: design e piano. **Irreversibili** — niente le
 * conserva altrove — e per questo sono le sole azioni di questa schermata a
 * chiedere conferma. Tutte le altre sono reversibili o innocue, e una
 * conferma su ognuna insegnerebbe solo a premere "sì" senza leggere.
 *
 * ⚠️ **La conferma è in una MODALE, e non è un dettaglio estetico.** Sul web
 * `ConfirmDeleteButton` sostituisce il bottone con "Conferma"/"Annulla" nello
 * STESSO punto: con un mouse va bene, su un telefono no — il secondo tocco
 * cadrebbe dove è appena caduto il primo, e un doppio tap involontario
 * cancellerebbe un design. Qui il secondo passo sta altrove, in un riquadro
 * che copre la pagina, con "Annulla" accanto: nessun gesto continuo può
 * attraversare tutti e due i passi.
 *
 * Per la stessa ragione questo blocco sta in FONDO alla schermata, fuori dal
 * percorso del pollice che scorre il piano e i commenti.
 *
 * Nessun gate di ruolo: le due rotte sono `requireAuth`. Un bottone compare
 * solo se c'è davvero qualcosa da cancellare — un 404 su un design che non
 * esiste sarebbe un errore per un gesto che non poteva funzionare.
 */
export function DestructiveActions({ ticketId, hasDesign, hasPlan }: DestructiveActionsProps) {
  const { t } = useTranslation();
  const deleteDesign = useDeleteDesign(ticketId);
  const deletePlan = useDeletePlan(ticketId);
  const [pending, setPending] = useState<Pending>(null);

  if (!hasDesign && !hasPlan) return null;

  const mutation = pending === "design" ? deleteDesign : deletePlan;

  function confirm(): void {
    if (pending === "design") deleteDesign.mutate();
    else if (pending === "plan") deletePlan.mutate();
    setPending(null);
  }

  return (
    <View style={styles.block} testID="work-destructive">
      <Text style={styles.eyebrow}>{t("mobile.work.destructive.title")}</Text>

      <View style={styles.row}>
        {hasDesign && (
          <DangerButton
            label={t("mobile.work.destructive.deleteDesign")}
            onPress={() => setPending("design")}
            disabled={deleteDesign.disabled}
            testID="work-delete-design"
          />
        )}
        {hasPlan && (
          <DangerButton
            label={t("mobile.work.destructive.deletePlan")}
            onPress={() => setPending("plan")}
            disabled={deletePlan.disabled}
            testID="work-delete-plan"
          />
        )}
      </View>

      {deleteDesign.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.error} testID="work-delete-design-error">
          {deleteDesign.errorMessage}
        </Text>
      )}
      {deletePlan.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.error} testID="work-delete-plan-error">
          {deletePlan.errorMessage}
        </Text>
      )}

      <Modal
        visible={pending !== null}
        animationType="fade"
        transparent
        onRequestClose={() => setPending(null)}
        testID="work-delete-confirm"
      >
        <View style={styles.backdrop}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setPending(null)}
            accessibilityLabel={t("mobile.work.destructive.cancel")}
          />
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.confirmTitle}>
              {pending === "design"
                ? t("mobile.work.destructive.confirmDesignTitle")
                : t("mobile.work.destructive.confirmPlanTitle")}
            </Text>
            <Text style={styles.confirmBody}>{t("mobile.work.destructive.confirmBody")}</Text>
            <View style={styles.confirmRow}>
              {/* "Annulla" per PRIMO: l'uscita sta dove il pollice arriva prima. */}
              <Pressable
                accessibilityRole="button"
                onPress={() => setPending(null)}
                style={styles.cancelButton}
                testID="work-delete-cancel"
              >
                <Text style={styles.cancelLabel}>{t("mobile.work.destructive.cancel")}</Text>
              </Pressable>
              <DangerButton
                label={t("mobile.work.destructive.confirm")}
                onPress={confirm}
                disabled={mutation.disabled}
                testID="work-delete-confirm-yes"
              />
            </View>
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

function DangerButton({
  label,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.danger, pressed && !disabled && styles.dangerPressed, disabled && styles.dangerDisabled]}
      testID={testID}
    >
      <Text style={styles.dangerLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 10,
  },
  eyebrow: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  danger: {
    borderColor: colors.danger,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  dangerPressed: {
    backgroundColor: colors.ink850,
  },
  dangerDisabled: {
    opacity: 0.5,
  },
  dangerLabel: {
    color: colors.danger,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.label,
  },
  backdrop: {
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.6)",
    flex: 1,
    justifyContent: "center",
    padding: 24,
  },
  sheet: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    gap: 10,
    padding: 18,
    width: "100%",
  },
  confirmTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 16,
    fontWeight: "600",
  },
  confirmBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    lineHeight: 20,
  },
  confirmRow: {
    flexDirection: "row",
    gap: 10,
    justifyContent: "flex-end",
    marginTop: 4,
  },
  cancelButton: {
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  cancelLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
});
