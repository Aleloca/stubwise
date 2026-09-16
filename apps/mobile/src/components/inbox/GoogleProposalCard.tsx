import type { InboxItem, Reader } from "@stubwise/shared";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text } from "react-native";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";
import { CardFooter, CardShell } from "./CardShell";

/**
 * La card di una PROPOSTA nata dalla posta o dal calendario
 * (`google.proposal`, 16 set 2026).
 *
 * ⚠️ Fino a oggi queste notifiche cadevano nel ramo `default` di `InboxCard`,
 * cioè in `InfoCard`: pura informazione, nessuna decisione possibile, e come
 * unico bottone «Apri il lavoro» — l'etichetta generica di quella card sopra
 * `item.url`, che per una proposta di posta è il link al thread su GMAIL. Il
 * maintainer se n'è accorto usando l'app con 34 proposte aperte, nessuna delle
 * quali si poteva chiudere dal telefono.
 *
 * **La card non decide: porta alla pagina che decide** (scelta del
 * maintainer). Una proposta confermata crea roba vera — una milestone, una
 * voce di backlog — e chi decide deve vedere prima da chi arriva, cosa dice e
 * cosa comporta ogni scelta. Tre bottoni in mezzo a un elenco non lo
 * permettono.
 */
export function GoogleProposalCard({
  item,
  projectName,
  onOpen,
}: {
  item: Reader<InboxItem>;
  projectName?: string;
  /** Apre la pagina della decisione: la passa lo screen, che ha la navigazione. */
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const google = item.google;

  return (
    <CardShell
      tone="signal"
      kindLabel={t(
        google !== undefined
          ? `mobile.inbox.google.source.${google.source}`
          : "mobile.inbox.kinds.googleProposal",
      )}
      projectName={projectName}
      createdAt={item.createdAt}
      footer={
        <CardFooter
          buttons={[
            {
              key: "decide",
              label: t("mobile.inbox.google.openDecision"),
              onPress: onOpen,
              emphasis: true,
              testID: `inbox-decide-${item.id}`,
            },
          ]}
        />
      }
      testID="google-proposal-card"
    >
      {google !== undefined && (
        <Text style={styles.from} numberOfLines={1}>
          {google.from}
        </Text>
      )}
      <Text style={styles.subject} numberOfLines={2}>
        {google?.subject ?? item.text}
      </Text>
      {google !== undefined && (
        <Text style={styles.signal}>{t(`mobile.inbox.google.signal.${google.signal}`)}</Text>
      )}
    </CardShell>
  );
}

const styles = StyleSheet.create({
  from: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
  },
  subject: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    marginTop: 2,
  },
  signal: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 4,
  },
});
