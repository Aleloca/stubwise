import type { InboxItem, Reader } from "@stubwise/shared";
import { reviewOutcomeNeedsAttention } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, StyleSheet, Text } from "react-native";
import { CardFooter, CardShell } from "./CardShell";
import { SnoozeSheet } from "./SnoozeSheet";
import { useHandled, useSnooze } from "../../lib/inbox-mutations";
import { can } from "../../lib/inbox-sections";
import { colors } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

export interface PrReadyCardProps {
  item: Reader<InboxItem>;
  projectName?: string;
}

/**
 * Aggiornamenti sulla pull request (`job.pr_opened`, `review.completed`,
 * canvas `1c` — "PR pronta al rilascio").
 *
 * ⚠️ **GAP NOTO rispetto al canvas, deliberato**: il mock mostra un bottone
 * "Rilascia (merge)" — non esiste alcuna azione `merge` nel contratto
 * (`inboxActionSchema` di `@stubwise/shared` ha solo `approve_plan`/
 * `reject_plan`/`relaunch`/`answer`/`open`/`snooze`/`handled`, e
 * `job.pr_opened`/`review.completed` hanno `decisions: []` nel catalogo
 * server — `packages/notifications/src/actions.ts`). Il rilascio di una PR va
 * ancora fatto dal provider git; questa card resta **informativa**: mostra
 * `item.text` (che include già l'esito della review — vedi
 * `notify.reviewCompleted`), il riassunto "in breve" della PR quando c'è
 * (fase 5: `item.summary`, due frasi su cosa fa la PR e come è andata la
 * review, SOTTO il testo perché lo approfondisce e non lo sostituisce) e i
 * soli bottoni che `actions` offre davvero
 * (`open`/`snooze`/`handled`). Aggiungere "Rilascia" richiederebbe
 * un'estensione additiva del contratto — vedi il report del Task 14.
 */
export function PrReadyCard({ item, projectName }: PrReadyCardProps) {
  const { t } = useTranslation();
  const snooze = useSnooze();
  const handled = useHandled();
  const [snoozeOpen, setSnoozeOpen] = useState(false);

  const kindLabelKey = item.kind === "review.completed" ? "mobile.inbox.kinds.reviewCompleted" : "mobile.inbox.kinds.prOpened";
  const tone = prReadyTone(item);

  const buttons = [];
  if (can(item, "open") && item.url !== undefined) {
    buttons.push({
      key: "open",
      label: t("mobile.inbox.actions.openWork"),
      emphasis: true,
      onPress: () => void Linking.openURL(item.url as string),
      testID: "pr-ready-card-open",
    });
  }
  if (can(item, "snooze")) {
    buttons.push({
      key: "snooze",
      label: t("mobile.inbox.actions.snooze"),
      onPress: () => setSnoozeOpen(true),
      testID: "pr-ready-card-snooze",
    });
  }
  if (can(item, "handled")) {
    buttons.push({
      key: "handled",
      label: t("mobile.inbox.actions.handled"),
      onPress: () => handled.mutate({ id: item.id }),
      testID: "pr-ready-card-handled",
    });
  }

  return (
    <CardShell
      tone={tone}
      kindLabel={t(kindLabelKey)}
      projectName={projectName}
      createdAt={item.createdAt}
      footer={buttons.length > 0 ? <CardFooter buttons={buttons} /> : undefined}
      errorMessage={snooze.errorMessage ?? handled.errorMessage}
      testID="pr-ready-card"
    >
      <Text style={styles.text}>{item.text}</Text>
      {item.summary !== undefined && (
        <Text style={styles.summary} testID="pr-ready-card-summary">
          {item.summary}
        </Text>
      )}

      <SnoozeSheet
        visible={snoozeOpen}
        onRequestClose={() => setSnoozeOpen(false)}
        onChoose={(until) => {
          setSnoozeOpen(false);
          snooze.mutate({ id: item.id, until });
        }}
        testID="pr-ready-card-snooze-sheet"
      />
    </CardShell>
  );
}

/**
 * Il tono della card (F8 del ciclo di correzione, 1 ott 2026). Verde SOLO per
 * una review che approva; di attenzione (`signal`) per modifiche richieste,
 * per lo stop del ciclo al tetto e per la review fallita — la regola è UNA,
 * `reviewOutcomeNeedsAttention` di `@stubwise/shared`, la stessa del web.
 * `job.pr_opened` resta com'era.
 *
 * `reviewOutcome` lo DERIVA il server a lettura dall'evento. In produzione
 * l'app parsa e un server vecchio lo fa arrivare `null` dal `.default`; dove
 * non si parsa (doppi e fixture) il campo può mancare del tutto, e `?? null`
 * lo porta al tono di prima — difensivo come il web.
 */
function prReadyTone(item: Reader<InboxItem>): "ok" | "signal" {
  if (item.kind !== "review.completed") return "ok";
  return reviewOutcomeNeedsAttention(item.reviewOutcome ?? null) ? "signal" : "ok";
}

const styles = StyleSheet.create({
  text: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 15,
    lineHeight: 21,
  },
  summary: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
  },
});
