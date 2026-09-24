import type { AiJob, Reader } from "@stubwise/shared";
import { isUnknown } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { GhostButton } from "../GhostButton";
import { PrimaryButton } from "../PrimaryButton";
import { useRunAi } from "../../lib/work-mutations";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * Gli stati TERMINALI da cui una persona può rilanciare il lavoro, identici a
 * `RELAUNCHABLE_STATUSES` sul web (`apps/web/src/routes/tickets/$id.tsx`):
 * `held` (gate dell'automazione), `pr_closed` (PR rifiutata), `failed` e
 * `skipped`.
 *
 * NON si rilancia da `pr_opened`/`pr_merged`, dagli stati in volo, da
 * `awaiting_plan_approval` (che ha i suoi bottoni) né da `awaiting_input`: lì
 * il job è VIVO e riparte da solo appena qualcuno risponde alla domanda —
 * rilanciarlo butterebbe via il lavoro fatto.
 */
const RELAUNCHABLE: readonly string[] = ["held", "pr_closed", "failed", "skipped"];

export interface RunWorkButtonProps {
  ticketId: string;
  /** L'ultimo job del ticket, `undefined` se non è mai partito nulla. */
  latestJob: Reader<AiJob> | undefined;
  /** C'è almeno un commento di una persona: "riprendi da lì" ha qualcosa da leggere. */
  hasUserComment: boolean;
}

/**
 * "Avvia il lavoro", e — su un ticket già tentato — "riprendi dalle
 * istruzioni".
 *
 * ⚠️ **Nessun gate di ruolo, ed è il punto.** Un operatore può lanciare un
 * run: il divieto dell'operatore non è "non avviare", è "non approvare da
 * solo il piano". Quel gate vive in `jobs.ts` lato server, che per un
 * `member` fa nascere il run già fermo su `awaiting_plan_approval` invece che
 * in coda — nascondere il bottone qui gli toglierebbe il lavoro quotidiano
 * senza proteggere nulla in più.
 *
 * `withInstructions` riprende dal fix incorporando i commenti della squadra;
 * senza opzione il triage riparte da capo. Quando un commento di una persona
 * non c'è, il secondo bottone non compare affatto: non avrebbe istruzioni da
 * riprendere.
 */
export function RunWorkButton({ ticketId, latestJob, hasUserComment }: RunWorkButtonProps) {
  const { t } = useTranslation();
  const run = useRunAi(ticketId);

  const status = latestJob !== undefined && !isUnknown(latestJob.status) ? latestJob.status : null;
  const canStart = latestJob === undefined;
  const canRelaunch = status !== null && RELAUNCHABLE.includes(status);
  if (!canStart && !canRelaunch) return null;

  return (
    <View style={styles.block} testID="work-run">
      <View style={styles.row}>
        <PrimaryButton
          label={run.isPending ? t("mobile.work.run.starting") : t("mobile.work.run.start")}
          onPress={() => run.mutate(undefined)}
          disabled={run.disabled}
          testID="work-run-start"
        />
        {canRelaunch && hasUserComment && (
          <GhostButton besidePrimary
            label={t("mobile.work.run.withInstructions")}
            onPress={() => run.mutate({ withInstructions: true })}
            disabled={run.disabled}
            testID="work-run-with-instructions"
          />
        )}
      </View>
      {run.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.error} testID="work-run-error">
          {run.errorMessage}
        </Text>
      )}
      {!run.online && (
        <Text style={styles.offline} testID="work-run-offline">
          {t("mobile.work.run.offline")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    gap: 8,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.label,
  },
  offline: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
});
