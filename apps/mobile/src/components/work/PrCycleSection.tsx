import type { Reader, TicketRepository } from "@stubwise/shared";
import { isUnknown } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { GhostButton } from "../GhostButton";
import { useRequestCorrection, useResumeCorrection } from "../../lib/correction-mutations";
import { prCycleLineFor, prCycleText } from "../../lib/pr-cycle";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { CorrectionSheet } from "./CorrectionSheet";
import type { CorrectionTarget } from "./CorrectionSheet";

type Repo = Reader<TicketRepository>;
type RepoWithPr = Repo & { prUrl: string };

export interface PrCycleSectionProps {
  ticketId: string;
  ticketNumber: number;
  repositories: Repo[];
}

/**
 * Le PR del ticket, una per repository, ciascuna con la riga di stato del
 * ciclo review → correzione, «Applica le correzioni» e — per una correzione
 * ferma — «Riprendi» (30 set 2026, design «correzioni post-PR» §9; G5).
 * Gemella di `pr-cycle-row.tsx` del web. Fino a qui l'app non mostrava le PR
 * del ticket da nessuna parte: `ticket.repositories` arrivava solo al livello
 * tecnico, e solo col branch.
 *
 * ⚠️ **Il client non decide niente.** La riga è `cycle` messo in parole
 * (`prCycleLineFor`/`prCycleText`), «Applica le correzioni» lo accende
 * `cycle.canRequestCorrection` e «Riprendi» compare solo con `cycle.canResume`
 * E `cycle.heldJobId` — mai dedotti qui da `prState`, dai job o dal ruolo.
 * `prState` serve solo a NON mostrare «Applica» su una PR chiusa, dove non
 * avrebbe senso nemmeno spento.
 *
 * `cycle: null` vuol dire «PR non aperta da Stubwise» oppure «server di prima
 * del ciclo»: la PR si mostra lo stesso (col suo link), senza riga né bottoni.
 *
 * Nessun gate di ruolo: una correzione la chiede chiunque possa lanciare un
 * run sul ticket (design §3), e il cancello è sul server.
 *
 * ⚠️ **Lo stato locale è DEL TICKET.** La schermata può passare a un altro
 * ticket senza smontare la sezione, e due ticket possono avere PR sugli
 * stessi repository: l'errore di una ripresa, il pannello aperto e l'esito
 * delle mutazioni del ticket di prima comparirebbero sotto le PR dell'altro.
 * Per questo il contenuto è keyato sul `ticketId` (si rimonta, e riparte
 * vuoto), e ogni riga su ticket + repository.
 */
export function PrCycleSection(props: PrCycleSectionProps) {
  return <PrCycleSectionBody key={props.ticketId} {...props} />;
}

function PrCycleSectionBody({ ticketId, ticketNumber, repositories }: PrCycleSectionProps) {
  const { t } = useTranslation();
  // UNA sola mutazione per azione, per tutta la sezione: «Applica» la passa al
  // pannello come `correction` (`reset()` e la guardia sull'invio in volo
  // stanno DENTRO `CorrectionSheet`, revisione di F4); «Riprendi» la usa
  // qui, e l'errore lo mostra sotto la riga che l'ha prodotto.
  const correction = useRequestCorrection(ticketId);
  const resume = useResumeCorrection(ticketId);
  const [target, setTarget] = useState<CorrectionTarget | null>(null);
  // Quale riga ha premuto «Riprendi»: la mutazione è una per la sezione, il
  // suo errore va sotto quella riga e basta.
  const [resumedRepositoryId, setResumedRepositoryId] = useState<string | null>(null);

  const withPr = repositories.filter((repo): repo is RepoWithPr => repo.prUrl !== null);
  if (withPr.length === 0) return null;

  function openSheet(repo: RepoWithPr): void {
    // Come il web: aprendo il pannello, l'esito di una ripresa precedente non
    // resta appeso sotto un'altra riga.
    resume.reset();
    setResumedRepositoryId(null);
    setTarget({ repositoryId: repo.repositoryId, repositoryName: repo.repositoryName ?? repo.repositorySlug });
  }

  function resumeFor(repositoryId: string, heldJobId: string): void {
    if (resume.disabled) return;
    correction.reset();
    setResumedRepositoryId(repositoryId);
    resume.resume(heldJobId, () => setResumedRepositoryId(null));
  }

  return (
    <View style={styles.card} testID="pr-cycle-section">
      <Text style={styles.eyebrow}>{t("mobile.work.pr.title")}</Text>
      {withPr.map((repo) => {
        const cycle = repo.cycle;
        const isOpen = !isUnknown(repo.prState) && repo.prState === "open";
        const line = cycle !== null ? prCycleLineFor(cycle) : null;
        // `?? false` / `?? null`: in produzione l'app parsa e i `.default()`
        // girano; qui la difesa serve dove non si parsa (doppi e fixture),
        // come sul web. Senza `heldJobId` «Riprendi» NON si offre: un run-ai
        // senza `resumeCorrectionJobId` non dice quale correzione riprendere
        // e, su una correzione nel frattempo chiusa, avvierebbe un fix nuovo.
        const heldJobId = cycle !== null && (cycle.canResume ?? false) ? (cycle.heldJobId ?? null) : null;
        const resumeError =
          resumedRepositoryId === repo.repositoryId && resume.errorMessage !== null ? resume.errorMessage : null;
        const resuming = resume.isPending && resumedRepositoryId === repo.repositoryId;

        return (
          <View key={`${ticketId}:${repo.repositoryId}`} style={styles.row} testID={`pr-cycle-${repo.repositoryId}`}>
            <View style={styles.header}>
              <Text style={styles.repoName} numberOfLines={1}>
                {repo.repositoryName ?? repo.repositorySlug}
              </Text>
              <Pressable
                accessibilityRole="link"
                hitSlop={8}
                onPress={() => void Linking.openURL(repo.prUrl)}
                testID={`pr-cycle-open-${repo.repositoryId}`}
              >
                <Text style={styles.link}>{t("mobile.work.pr.openPr")}</Text>
              </Pressable>
            </View>

            {line !== null && (
              <Text style={[styles.line, { color: colors[line.tone] }]} testID={`pr-cycle-line-${repo.repositoryId}`}>
                {prCycleText(line, t)}
              </Text>
            )}

            {cycle !== null && (isOpen || heldJobId !== null) && (
              <View style={styles.actions}>
                {isOpen && (
                  <GhostButton
                    label={t("mobile.work.pr.requestCorrection")}
                    onPress={() => openSheet(repo)}
                    disabled={!cycle.canRequestCorrection || correction.disabled || resume.isPending}
                    testID={`pr-cycle-request-${repo.repositoryId}`}
                  />
                )}
                {heldJobId !== null && (
                  <GhostButton
                    label={resuming ? t("mobile.work.pr.resuming") : t("mobile.work.pr.resume")}
                    onPress={() => resumeFor(repo.repositoryId, heldJobId)}
                    disabled={resume.disabled || correction.isPending}
                    testID={`pr-cycle-resume-${repo.repositoryId}`}
                  />
                )}
              </View>
            )}

            {heldJobId !== null && !resume.online && (
              <Text style={styles.offline} testID={`pr-cycle-resume-offline-${repo.repositoryId}`}>
                {t("mobile.work.pr.resumeOffline")}
              </Text>
            )}

            {resumeError !== null && (
              <Text
                accessibilityLiveRegion="polite"
                style={styles.error}
                testID={`pr-cycle-resume-error-${repo.repositoryId}`}
              >
                {resumeError}
              </Text>
            )}
          </View>
        );
      })}

      {/* `onClose` è idempotente (dopo un successo arriva due volte, vedi il
          docblock di `CorrectionSheet`): fa solo `setTarget(null)`. */}
      <CorrectionSheet
        target={target}
        ticketId={ticketId}
        ticketNumber={ticketNumber}
        correction={correction}
        onClose={() => setTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    gap: 14,
    padding: 16,
  },
  eyebrow: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  row: {
    gap: 6,
  },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  repoName: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: fontSize.body,
    fontWeight: "600",
  },
  link: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  line: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    lineHeight: 16,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 2,
  },
  offline: {
    color: colors.signal,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: 13,
  },
});
