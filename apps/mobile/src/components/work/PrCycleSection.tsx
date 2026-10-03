import type { Reader, TicketRepository } from "@stubwise/shared";
import { isSafeWebUrl, prNumberFromUrl } from "@stubwise/shared";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { GhostButton } from "../GhostButton";
import { useRequestCorrection, useResumeCorrection } from "../../lib/correction-mutations";
import { actionsOf, prCycleCardFor } from "../../lib/pr-cycle";
import type { PrCycleCard } from "../../lib/pr-cycle";
import { relativeTimeAgo } from "../../lib/format";
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
 * ciclo review → correzione, «Chiedi modifiche» e — per una correzione
 * ferma — «Riprendi» (30 set 2026, design «correzioni post-PR» §9; G5).
 * Gemella di `pr-cycle-row.tsx` del web. Fino a qui l'app non mostrava le PR
 * del ticket da nessuna parte: `ticket.repositories` arrivava solo al livello
 * tecnico, e solo col branch.
 *
 * Dal 2 ott 2026 (pagina del ticket a tab, design §5) ogni PR è una CARD:
 * titolo «repository · PR #N ↗» che apre la PR, chip dello stato col suo
 * tono, dettagli e «chi ha chiesto» in grigio, bottone a tutta larghezza. La
 * frase intera del web (`prCycleLineFor`) qui è spezzata da
 * `prCycleCardFor`, che dice la stessa cosa (parità sui pezzi nei test).
 *
 * ⚠️ **Il client non decide niente.** La card è `cycle` messo in parole
 * (`prCycleCardFor`), «Chiedi modifiche» lo accende
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
  if (!hasPrToShow(props.repositories)) return null;
  return <PrCycleSectionBody key={props.ticketId} {...props} />;
}

function PrCycleSectionBody({ ticketId, ticketNumber, repositories }: PrCycleSectionProps) {
  const { t } = useTranslation();
  // UNA sola mutazione per azione, per tutta la sezione: «Applica» la passa al
  // pannello come `correction` (`reset()` e la guardia sull'invio in volo
  // stanno DENTRO `CorrectionSheet`, revisione di F4); «Riprendi» la usa
  // qui, e l'errore lo mostra sotto la riga che l'ha prodotto.
  //
  // ⚠️ Condivise di proposito, e quindi una richiesta in volo su UNA riga
  // spegne i bottoni di TUTTE le righe. Sul web si spegne solo la riga in
  // volo; qui no, e non è una svista: il server risponderebbe comunque
  // `job_in_flight` a una seconda azione sullo stesso ticket (il job vivo
  // blocca per ticket, non per PR), quindi un bottone acceso su un'altra riga
  // prometterebbe un'azione che non può partire.
  const correction = useRequestCorrection(ticketId);
  const resume = useResumeCorrection(ticketId);
  const [target, setTarget] = useState<CorrectionTarget | null>(null);
  // Quale riga ha premuto «Riprendi»: la mutazione è una per la sezione, il
  // suo errore va sotto quella riga e basta.
  const [resumedRepositoryId, setResumedRepositoryId] = useState<string | null>(null);

  const withPr = repositories.filter(hasPr);

  // Senza rete i bottoni sono spenti (`disabled` delle due mutazioni): la
  // sezione dice perché UNA volta, se almeno una riga offre un'azione.
  const offersAction = withPr.some((repo) => actionsOf(repo).request || actionsOf(repo).resumeJobId !== null);

  function openSheet(repo: RepoWithPr): void {
    // Come il web: aprendo il pannello, l'esito di una ripresa precedente non
    // resta appeso sotto un'altra riga.
    resume.reset();
    setResumedRepositoryId(null);
    setTarget({ repositoryId: repo.repositoryId, repositoryName: repo.repositoryName ?? repo.repositorySlug });
  }

  function resumeFor(repositoryId: string, heldJobId: string): void {
    if (resume.disabled) return;
    // La riga si ricorda SOLO se la richiesta è partita: con due tap su righe
    // diverse nello stesso frame (i bottoni si spengono al render dopo) parte
    // la prima, la guardia dell'hook scarta la seconda, e l'esito della prima
    // finirebbe sotto la riga sbagliata se si ricordasse l'ultimo tap.
    const started = resume.resume(heldJobId, () => setResumedRepositoryId(null));
    if (!started) return;
    correction.reset();
    setResumedRepositoryId(repositoryId);
  }

  return (
    <View style={styles.section} testID="pr-cycle-section">
      {withPr.map((repo) => {
        const cycle = repo.cycle;
        const card = cycle !== null ? prCycleCardFor(cycle, { prOpen: repo.prState === "open" }) : null;
        const { request: offersRequest, resumeJobId: heldJobId } = actionsOf(repo);
        const resumeError =
          resumedRepositoryId === repo.repositoryId && resume.errorMessage !== null ? resume.errorMessage : null;
        const resuming = resume.isPending && resumedRepositoryId === repo.repositoryId;
        // L'URL della PR lo scrive il provider, non noi: il titolo apre il link
        // solo se è http/https (`isSafeWebUrl`), altrimenti è testo e basta.
        const linkable = isSafeWebUrl(repo.prUrl);
        const prNumber = prNumberFromUrl(repo.prUrl);
        const title = [
          repo.repositoryName ?? repo.repositorySlug,
          prNumber !== null ? t("mobile.work.pr.prNumber", { number: prNumber }) : t("mobile.work.pr.prNoNumber"),
        ].join(" · ");
        const closedLabel =
          repo.prState === "merged"
            ? t("mobile.work.pr.state.merged")
            : repo.prState === "closed_unmerged"
              ? t("mobile.work.pr.state.closed")
              : null;
        const asked = card === null ? null : askedText(card, t);

        return (
          <View key={`${ticketId}:${repo.repositoryId}`} style={styles.card} testID={`pr-cycle-${repo.repositoryId}`}>
            <View style={styles.header}>
              {linkable ? (
                <Pressable
                  // Il titolo SENZA la freccia: «↗» è un segno per l'occhio,
                  // letto ad alta voce è rumore («freccia in alto a destra»).
                  accessibilityLabel={title}
                  accessibilityRole="link"
                  hitSlop={8}
                  onPress={() => {
                    // Un rifiuto (nessuna app che apre il link) non deve
                    // diventare una promise rifiutata senza gestore.
                    Linking.openURL(repo.prUrl).catch(() => {});
                  }}
                  style={styles.titlePress}
                  testID={`pr-cycle-open-${repo.repositoryId}`}
                >
                  <Text numberOfLines={2} style={styles.title} testID={`pr-cycle-title-${repo.repositoryId}`}>
                    {`${title} ↗`}
                  </Text>
                </Pressable>
              ) : (
                <Text numberOfLines={2} style={[styles.title, styles.titlePress]} testID={`pr-cycle-title-${repo.repositoryId}`}>
                  {title}
                </Text>
              )}
              {closedLabel !== null && (
                <Text style={styles.closedLabel} testID={`pr-cycle-state-${repo.repositoryId}`}>
                  {closedLabel}
                </Text>
              )}
            </View>

            {card !== null && (
              <View style={styles.chipRow}>
                <View style={[styles.chipDot, { backgroundColor: colors[card.tone] }]} />
                <Text style={[styles.chip, { color: colors[card.tone] }]} testID={`pr-cycle-chip-${repo.repositoryId}`}>
                  {t(card.chip.key, card.chip.params)}
                </Text>
              </View>
            )}

            {card !== null && card.details.length > 0 && (
              <Text style={styles.grey} testID={`pr-cycle-detail-${repo.repositoryId}`}>
                {card.details.map((detail) => t(detail.key, detail.params)).join(" · ")}
              </Text>
            )}

            {asked !== null && (
              <Text style={styles.grey} testID={`pr-cycle-asked-${repo.repositoryId}`}>
                {asked}
              </Text>
            )}

            {cycle !== null && (offersRequest || heldJobId !== null) && (
              <View style={styles.actions} testID={`pr-cycle-actions-${repo.repositoryId}`}>
                {offersRequest && (
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

      {offersAction && !resume.online && (
        <Text style={styles.offline} testID="pr-cycle-offline">
          {t("mobile.work.pr.offline")}
        </Text>
      )}

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

/**
 * La riga grigia «chi ha chiesto»: il testo di oggi, gemello del web
 * («Modifiche richieste da X su Bitbucket»), più il tempo relativo calcolato
 * QUI dalla data (`relativeTimeAgo`, mai un numero dal server) e, se la
 * richiesta aspetta il lavoro in corso, «in coda · …». `null` senza una
 * richiesta umana. Una data illeggibile toglie solo il tempo.
 */
function askedText(card: PrCycleCard, t: TFunction): string | null {
  if (card.request === null) return null;
  const time = card.requestAt === null ? null : relativeTimeAgo(card.requestAt, t);
  const parts = [t(card.request.key, card.request.params)];
  if (time !== null) parts.push(time);
  if (card.queued) parts.push(t("mobile.work.pr.cycle.queued"));
  return parts.join(" · ");
}

function hasPr(repo: Repo): repo is RepoWithPr {
  return repo.prUrl !== null;
}

/**
 * Se la sezione rende qualcosa: almeno una PR sul ticket. È l'UNICO posto in
 * cui la condizione è scritta — la schermata la usa per non montare il suo
 * contenitore (con il margine) attorno a una sezione che non c'è.
 */
export function hasPrToShow(repositories: readonly Repo[]): boolean {
  return repositories.some(hasPr);
}

const styles = StyleSheet.create({
  section: {
    gap: 12,
  },
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  header: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10,
  },
  titlePress: {
    flexShrink: 1,
  },
  title: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: fontSize.body,
    fontWeight: "600",
  },
  closedLabel: {
    borderColor: colors.line,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    paddingHorizontal: 6,
  },
  chipRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  chipDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  chip: {
    flexShrink: 1,
    fontFamily: fontFamily.monoMedium,
    fontSize: 12,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  grey: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
    lineHeight: 16,
  },
  actions: {
    flexDirection: "column",
    gap: 10,
    marginTop: 4,
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
