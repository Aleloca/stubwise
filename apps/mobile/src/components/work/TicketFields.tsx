import type { MilestoneWithCounts, PublicUser, Reader, TicketDetail } from "@stubwise/shared";
import { isUnknown } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ChoiceSheet, type Choice } from "./ChoiceSheet";
import { usePatchTicket } from "../../lib/work-mutations";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  ticketPriorityLabel,
  ticketStatusLabel,
} from "../../lib/ticket-labels";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Quale campo ha la sheet aperta; `null` = nessuna. */
type OpenField = "status" | "priority" | "assignee" | "milestone" | null;

export interface TicketFieldsProps {
  ticket: Reader<TicketDetail>;
  /** `undefined` finché la query non ha risposto, o se è fallita. */
  users: Reader<PublicUser>[] | undefined;
  /** Idem per le milestone del progetto. */
  milestones: Reader<MilestoneWithCounts>[] | undefined;
}

/**
 * I campi modificabili di un ticket: stato, priorità, assegnatario,
 * milestone — gli stessi quattro che la pagina web modifica dal suo pannello
 * di destra (`patchMutation`, `apps/web/src/routes/tickets/$id.tsx`).
 *
 * ⚠️ **Nessun controllo di ruolo**, e non è una dimenticanza: la rotta è
 * `requireAuth`, non `requireAdmin` — cambiare lo stato di un ticket o
 * assegnarlo a qualcuno è lavoro quotidiano anche per un operatore.
 * Aggiungerne uno qui sarebbe una seconda copia della regola, e la copia
 * sbagliata starebbe nell'app, che si aggiorna dagli store e non dai nostri
 * deploy.
 *
 * Un elenco che non è ancora arrivato (o la cui query è fallita) rende la sua
 * riga NON premibile invece di aprire una sheet vuota: il valore corrente
 * resta leggibile, che è la metà che conta. Le due letture sono decorazione
 * della modifica, non della schermata — un loro guasto costa quei due campi,
 * mai la pagina.
 */
export function TicketFields({ ticket, users, milestones }: TicketFieldsProps) {
  const { t } = useTranslation();
  const patch = usePatchTicket(ticket.id);
  const [open, setOpen] = useState<OpenField>(null);

  const assignee = users?.find((user) => user.id === ticket.assigneeId);
  const milestone = milestones?.find((item) => item.id === ticket.milestoneId);

  const noneChoice: Choice = { value: null, label: t("mobile.work.fields.none") };
  const userChoices: Choice[] = [noneChoice, ...(users ?? []).map((user) => ({ value: user.id, label: user.email }))];
  const milestoneChoices: Choice[] = [
    noneChoice,
    ...(milestones ?? []).map((item) => ({ value: item.id, label: item.name })),
  ];

  /**
   * Una scelta uguale a quella corrente non manda nulla: una PATCH che non
   * cambia niente sarebbe comunque un `updated_at` toccato e una riga di
   * audit, cioè rumore su una timeline che si legge per capire cosa è
   * successo davvero.
   */
  function chooseStatus(value: string | null): void {
    setOpen(null);
    const status = TICKET_STATUSES.find((candidate) => candidate === value);
    if (status === undefined || status === ticket.status) return;
    patch.mutate({ status });
  }

  function choosePriority(value: string | null): void {
    setOpen(null);
    const priority = TICKET_PRIORITIES.find((candidate) => candidate === value);
    if (priority === undefined || priority === ticket.priority) return;
    patch.mutate({ priority });
  }

  function chooseAssignee(value: string | null): void {
    setOpen(null);
    if (value === (ticket.assigneeId ?? null)) return;
    patch.mutate({ assigneeId: value });
  }

  function chooseMilestone(value: string | null): void {
    setOpen(null);
    if (value === (ticket.milestoneId ?? null)) return;
    patch.mutate({ milestoneId: value });
  }

  return (
    <View style={styles.card} testID="ticket-fields">
      <Text style={styles.eyebrow}>{t("mobile.work.fields.title")}</Text>

      <FieldRow
        label={t("mobile.work.fields.status")}
        value={ticketStatusLabel(ticket.status, t)}
        onPress={() => setOpen("status")}
        disabled={patch.disabled}
        testID="ticket-field-status"
      />
      <FieldRow
        label={t("mobile.work.fields.priority")}
        value={ticketPriorityLabel(ticket.priority, t)}
        onPress={() => setOpen("priority")}
        disabled={patch.disabled}
        testID="ticket-field-priority"
      />
      <FieldRow
        label={t("mobile.work.fields.assignee")}
        value={assignee?.email ?? t("mobile.work.fields.none")}
        onPress={users === undefined ? undefined : () => setOpen("assignee")}
        disabled={patch.disabled}
        testID="ticket-field-assignee"
      />
      <FieldRow
        label={t("mobile.work.fields.milestone")}
        value={milestone?.name ?? t("mobile.work.fields.none")}
        onPress={milestones === undefined ? undefined : () => setOpen("milestone")}
        disabled={patch.disabled}
        testID="ticket-field-milestone"
      />

      {patch.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.error} testID="ticket-fields-error">
          {patch.errorMessage}
        </Text>
      )}
      {!patch.online && (
        <Text style={styles.offline} testID="ticket-fields-offline">
          {t("mobile.work.fields.offline")}
        </Text>
      )}

      <ChoiceSheet
        visible={open === "status"}
        title={t("mobile.work.fields.status")}
        choices={TICKET_STATUSES.map((status) => ({ value: status, label: ticketStatusLabel(status, t) }))}
        selected={isUnknown(ticket.status) ? null : ticket.status}
        onChoose={chooseStatus}
        onRequestClose={() => setOpen(null)}
        disabled={patch.disabled}
        testIDPrefix="ticket-field-status-choice"
      />
      <ChoiceSheet
        visible={open === "priority"}
        title={t("mobile.work.fields.priority")}
        choices={TICKET_PRIORITIES.map((priority) => ({ value: priority, label: ticketPriorityLabel(priority, t) }))}
        selected={isUnknown(ticket.priority) ? null : ticket.priority}
        onChoose={choosePriority}
        onRequestClose={() => setOpen(null)}
        disabled={patch.disabled}
        testIDPrefix="ticket-field-priority-choice"
      />
      <ChoiceSheet
        visible={open === "assignee"}
        title={t("mobile.work.fields.assignee")}
        choices={userChoices}
        selected={ticket.assigneeId ?? null}
        onChoose={chooseAssignee}
        onRequestClose={() => setOpen(null)}
        disabled={patch.disabled}
        testIDPrefix="ticket-field-assignee-choice"
      />
      <ChoiceSheet
        visible={open === "milestone"}
        title={t("mobile.work.fields.milestone")}
        choices={milestoneChoices}
        selected={ticket.milestoneId ?? null}
        onChoose={chooseMilestone}
        onRequestClose={() => setOpen(null)}
        disabled={patch.disabled}
        testIDPrefix="ticket-field-milestone-choice"
      />
    </View>
  );
}

/**
 * Una riga "etichetta → valore". Senza `onPress` non è premibile e non finge
 * di esserlo (nessun chevron): è la forma che prende un campo il cui elenco
 * non è arrivato.
 */
function FieldRow({
  label,
  value,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  value: string;
  onPress?: () => void;
  disabled: boolean;
  testID: string;
}) {
  if (onPress === undefined) {
    return (
      <View style={styles.row} testID={testID}>
        <Text style={styles.rowLabel}>{label}</Text>
        <Text style={styles.rowValue}>{value}</Text>
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && !disabled && styles.rowPressed, disabled && styles.rowDisabled]}
      testID={testID}
    >
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    padding: 14,
  },
  eyebrow: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingVertical: 11,
  },
  rowPressed: {
    opacity: 0.6,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  rowLabel: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  rowValue: {
    color: colors.fg,
    flex: 1,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
    textAlign: "right",
  },
  chevron: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.body,
  },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.label,
    marginTop: 8,
  },
  offline: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 8,
  },
});
