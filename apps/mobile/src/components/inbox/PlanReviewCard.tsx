import type { InboxItem, Reader } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { CardFooter, CardShell } from "./CardShell";
import { RejectSheet } from "./RejectSheet";
import { SnoozeSheet } from "./SnoozeSheet";
import { GhostButton } from "../GhostButton";
import { PrimaryButton } from "../PrimaryButton";
import { useApprove, useHandled, useReject, useSnooze } from "../../lib/inbox-mutations";
import { can } from "../../lib/inbox-sections";
import { colors } from "../../theme/tokens";

export interface PlanReviewCardProps {
  item: Reader<InboxItem>;
  projectName?: string;
}

/**
 * Piano da approvare (`job.plan_review`, solo maintainer, canvas `1c`/`1e`).
 * "Approva" chiede conferma inline (un tap accidentale non deve far partire
 * un'esecuzione): il bottone si trasforma in "Confermi? · Sì, approva /
 * Annulla" invece di eseguire subito. "Rifiuta con istruzioni" apre lo sheet
 * di rifiuto — il rifiuto non è un vicolo cieco, rigenera il piano.
 */
export function PlanReviewCard({ item, projectName }: PlanReviewCardProps) {
  const { t } = useTranslation();
  const approve = useApprove();
  const reject = useReject();
  const snooze = useSnooze();
  const handled = useHandled();
  const [confirmingApprove, setConfirmingApprove] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const footerButtons = [];
  if (can(item, "snooze")) {
    footerButtons.push({
      key: "snooze",
      label: t("mobile.inbox.actions.snooze"),
      onPress: () => setSnoozeOpen(true),
      testID: "plan-review-card-snooze",
    });
  }
  if (can(item, "handled")) {
    footerButtons.push({
      key: "handled",
      label: t("mobile.inbox.actions.handled"),
      onPress: () => handled.mutate({ id: item.id }),
      testID: "plan-review-card-handled",
    });
  }

  return (
    <CardShell
      tone="signal"
      kindLabel={t("mobile.inbox.kinds.planReview")}
      projectName={projectName}
      createdAt={item.createdAt}
      footer={footerButtons.length > 0 ? <CardFooter buttons={footerButtons} /> : undefined}
      errorMessage={approve.errorMessage ?? snooze.errorMessage ?? handled.errorMessage}
      testID="plan-review-card"
    >
      <Text style={styles.text}>{item.text}</Text>

      {(can(item, "approve_plan") || can(item, "reject_plan")) && (
        <View style={styles.actions}>
          {can(item, "approve_plan") &&
            (confirmingApprove ? (
              <View style={styles.confirmRow} testID="plan-review-card-confirm-row">
                <Text style={styles.confirmQuestion}>{t("mobile.inbox.actions.approveConfirmQuestion")}</Text>
                <View style={styles.confirmButtons}>
                  <View style={styles.confirmPrimary}>
                    <PrimaryButton
                      label={t("mobile.inbox.actions.approveConfirm")}
                      onPress={() => {
                        setConfirmingApprove(false);
                        approve.mutate({ id: item.id });
                      }}
                      disabled={approve.disabled}
                      testID="plan-review-card-approve-confirm"
                    />
                  </View>
                  <View style={styles.confirmSecondary}>
                    <GhostButton
                      label={t("mobile.inbox.actions.cancel")}
                      onPress={() => setConfirmingApprove(false)}
                      testID="plan-review-card-approve-cancel"
                    />
                  </View>
                </View>
              </View>
            ) : (
              <View style={styles.approveButton}>
                <PrimaryButton
                  label={t("mobile.inbox.actions.approve")}
                  onPress={() => setConfirmingApprove(true)}
                  disabled={approve.disabled}
                  testID="plan-review-card-approve"
                />
              </View>
            ))}
          {can(item, "reject_plan") && !confirmingApprove && (
            <View style={styles.rejectButton}>
              <GhostButton
                label={t("mobile.inbox.actions.rejectWithInstructions")}
                onPress={() => setRejectOpen(true)}
                testID="plan-review-card-reject"
              />
            </View>
          )}
        </View>
      )}

      <RejectSheet
        visible={rejectOpen}
        onRequestClose={() => setRejectOpen(false)}
        contextLine={item.text}
        onSubmit={(instructions) => {
          reject.mutate({ id: item.id, body: instructions !== undefined ? { instructions } : undefined });
        }}
        pending={reject.isPending}
        disabled={reject.disabled}
        online={reject.online}
        errorMessage={reject.errorMessage}
        testID="plan-review-card-reject-sheet"
      />

      <SnoozeSheet
        visible={snoozeOpen}
        onRequestClose={() => setSnoozeOpen(false)}
        onChoose={(until) => {
          setSnoozeOpen(false);
          snooze.mutate({ id: item.id, until });
        }}
        testID="plan-review-card-snooze-sheet"
      />
    </CardShell>
  );
}

const styles = StyleSheet.create({
  text: {
    color: colors.fg,
    fontSize: 15,
    lineHeight: 21,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
  },
  approveButton: {
    flex: 1,
  },
  rejectButton: {
    flex: 1.4,
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
});
