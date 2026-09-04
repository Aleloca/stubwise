import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Markdown from "react-native-markdown-display";
import { RejectSheet } from "../inbox/RejectSheet";
import { GhostButton } from "../GhostButton";
import { PrimaryButton } from "../PrimaryButton";
import { useApprovePlan, useRejectPlan } from "../../lib/work-mutations";
import { colors, radii } from "../../theme/tokens";
import { MARKDOWN_STYLE } from "../../theme/markdown";
import { fontFamily, fontSize } from "../../theme/typography";

export interface PlanSectionProps {
  ticketId: string;
  /** Riga di contesto della sheet di rifiuto (canvas `1e`: "Piano: … — Progetto"). */
  ticketTitle: string;
  plan: string | null;
  /** `job.status === "awaiting_plan_approval" && ruolo admin` — decide il chiamante (`WorkScreen`), non questo componente. */
  canDecide: boolean;
}

/**
 * "Il piano, in breve" + Approva/Rifiuta (canvas `2d`): il piano stesso è
 * SEMPRE visibile quando c'è (informativo, per contesto — la nota del flusso
 * "Maintainer" nel canvas: "Piano in breve + tecnico… opzionale, per
 * contesto"), i bottoni di decisione solo quando `canDecide`.
 *
 * "Leggi il piano completo" apre il testo INTERO in una modale, renderizzato
 * con `react-native-markdown-display`, stile in `theme/markdown.ts`
 * (`MARKDOWN_STYLE`, condiviso con `DocsPageScreen.tsx` — Task 18, UNICA
 * definizione: prima duplicato char-per-char nei due file). Sanitizzazione:
 * markdown-it (la libreria sotto al renderer) ha `html: false` di DEFAULT —
 * un tag HTML nel testo viene escapato a testo letterale, mai interpretato —
 * verificato nella sorgente del pacchetto prima di aggiungerlo; nessuna
 * config esplicita necessaria, ma NESSUNO tolga questa nota pensando che
 * manchi una configurazione.
 */
export function PlanSection({ ticketId, ticketTitle, plan, canDecide }: PlanSectionProps) {
  const { t } = useTranslation();
  const approve = useApprovePlan(ticketId);
  const reject = useRejectPlan(ticketId);
  const [confirmingApprove, setConfirmingApprove] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [readOpen, setReadOpen] = useState(false);

  return (
    <View>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>{t("mobile.work.plan.title")}</Text>
        {plan === null ? (
          <Text style={styles.empty}>{t("mobile.work.plan.empty")}</Text>
        ) : (
          <>
            <Text style={styles.excerpt} numberOfLines={4}>
              {plan}
            </Text>
            <Pressable onPress={() => setReadOpen(true)} testID="plan-section-read">
              <Text style={styles.readFull}>{t("mobile.work.plan.readFull")}</Text>
            </Pressable>
          </>
        )}
      </View>

      {canDecide && (
        <View style={styles.actions}>
          {confirmingApprove ? (
            <View style={styles.confirmRow} testID="plan-section-confirm-row">
              <Text style={styles.confirmQuestion}>{t("mobile.work.plan.approveConfirmQuestion")}</Text>
              <View style={styles.confirmButtons}>
                <View style={styles.confirmPrimary}>
                  <PrimaryButton
                    label={t("mobile.work.plan.approveConfirm")}
                    onPress={() => {
                      setConfirmingApprove(false);
                      approve.mutate();
                    }}
                    disabled={approve.disabled}
                    testID="plan-section-approve-confirm"
                  />
                </View>
                <View style={styles.confirmSecondary}>
                  <GhostButton
                    label={t("mobile.work.plan.cancel")}
                    onPress={() => setConfirmingApprove(false)}
                    testID="plan-section-approve-cancel"
                  />
                </View>
              </View>
            </View>
          ) : (
            <>
              <View style={styles.approveButton}>
                <PrimaryButton
                  label={t("mobile.work.plan.approve")}
                  onPress={() => setConfirmingApprove(true)}
                  disabled={approve.disabled}
                  testID="plan-section-approve"
                />
              </View>
              <View style={styles.rejectButton}>
                <GhostButton
                  label={t("mobile.work.plan.rejectWithInstructions")}
                  onPress={() => setRejectOpen(true)}
                  testID="plan-section-reject"
                />
              </View>
            </>
          )}
        </View>
      )}

      {(approve.errorMessage ?? reject.errorMessage) !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.errorText}>
          {approve.errorMessage ?? reject.errorMessage}
        </Text>
      )}

      <RejectSheet
        visible={rejectOpen}
        onRequestClose={() => setRejectOpen(false)}
        contextLine={ticketTitle}
        onSubmit={(instructions) => reject.mutate(instructions)}
        pending={reject.isPending}
        disabled={reject.disabled}
        online={reject.online}
        errorMessage={reject.errorMessage}
        testID="plan-section-reject-sheet"
      />

      <Modal visible={readOpen} animationType="slide" onRequestClose={() => setReadOpen(false)} testID="plan-section-modal">
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t("mobile.work.plan.modalTitle")}</Text>
            <Pressable onPress={() => setReadOpen(false)} testID="plan-section-modal-close">
              <Text style={styles.modalClose}>{t("mobile.work.plan.close")}</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.modalBody}>
            {plan !== null && <Markdown style={MARKDOWN_STYLE}>{plan}</Markdown>}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    padding: 16,
  },
  eyebrow: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  empty: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 8,
  },
  excerpt: {
    color: colors.fg,
    fontSize: fontSize.body,
    lineHeight: 20,
    marginTop: 8,
  },
  readFull: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 8,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 10,
  },
  approveButton: {
    flex: 1,
  },
  rejectButton: {
    flex: 1.6,
  },
  confirmRow: {
    flex: 1,
  },
  confirmQuestion: {
    color: colors.muted,
    fontSize: 13,
    marginBottom: 8,
  },
  confirmButtons: {
    flexDirection: "row",
    gap: 8,
  },
  confirmPrimary: {
    flex: 1,
  },
  confirmSecondary: {
    flex: 1,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginTop: 8,
  },
  modal: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  modalHeader: {
    alignItems: "center",
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 14,
  },
  modalTitle: {
    color: colors.fg,
    fontSize: 18,
    fontWeight: "700",
  },
  modalClose: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  modalBody: {
    padding: 20,
    paddingBottom: 40,
  },
});
