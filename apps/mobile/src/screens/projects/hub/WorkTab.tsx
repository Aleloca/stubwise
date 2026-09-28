import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ProjectsStackParamList } from "../../../app/navigation";
import { useAuth } from "../../../app/providers";
import { GhostButton } from "../../../components/GhostButton";
import { Skeleton } from "../../../components/Skeleton";
import { openedSince } from "../../../lib/format";
import { backlogSummary } from "../../../lib/project-hub";
import { OPEN_TICKET_STATUSES } from "../../../lib/project-tickets";
import { colors, radii } from "../../../theme/tokens";
import { fontFamily } from "../../../theme/typography";
import { HubBlockHeader, HubCard, HubRow, hubText } from "./hub-ui";
import { hubKeys } from "./hub-keys";

type Navigation = NativeStackScreenProps<ProjectsStackParamList, "Detail">["navigation"];

/** Quante righe mostra ciascun blocco (design §5): tre ticket, due notifiche. */
const TICKET_ROWS = 3;
const INBOX_ROWS = 2;

/** L'età a destra di un ticket: «oggi», «5 g», oltre i due mesi in mesi. */
function ticketAge(createdAt: string, now: number, t: TFunction): string | null {
  const opened = openedSince(createdAt, now);
  if (opened === null) return null;
  if (opened.kind === "today") return t("mobile.projects.detail.work.ageToday");
  if (opened.kind === "days") return t("mobile.projects.detail.work.ageDays", { count: opened.count });
  return t("mobile.projects.detail.work.ageMonths", { count: opened.count });
}

/**
 * Lo stato comune di un blocco: in attesa o in errore. Il «vuoto» lo decide
 * ciascuno, perché vuol dire cose diverse e merita parole diverse.
 */
function BlockStatus({
  query,
  testID,
}: {
  query: { isPending: boolean; isError: boolean; refetch: () => unknown };
  testID: string;
}) {
  const { t } = useTranslation();
  if (query.isPending) return <Skeleton height={48} />;
  if (query.isError) {
    return (
      <HubCard testID={`${testID}-error`}>
        <View style={styles.errorBody}>
          <Text style={styles.muted}>{t("mobile.projects.hub.loadError")}</Text>
          <GhostButton label={t("mobile.projects.hub.retry")} onPress={() => void query.refetch()} />
        </View>
      </HubCard>
    );
  }
  return null;
}

function EmptyCard({ text }: { text: string }) {
  return (
    <HubCard>
      <HubRow first>
        <Text style={styles.muted}>{text}</Text>
      </HubRow>
    </HubCard>
  );
}

/**
 * TAB «LAVORO» (28 set 2026, dettaglio progetto v3 §5): cosa C'È DA FARE —
 * ticket, backlog, notifiche. Ogni blocco ha la sua `useQuery`, indipendente e
 * FUORI da ogni gate della schermata: uno che fallisce mostra il suo errore e
 * gli altri restano.
 *
 * I conteggi vengono da `total` della risposta, non dalle righe ricevute: con
 * un `limit` contarle direbbe sempre «3». Senza `total` (un server più vecchio)
 * il numero NON si inventa: l'etichetta resta senza, e il backlog perde la
 * barra — «da preparare» richiede il totale.
 */
export function WorkTab({
  projectId,
  projectName,
  backlogReadyCount,
  navigation,
}: {
  projectId: string;
  projectName: string;
  backlogReadyCount: number;
  navigation: Navigation;
}) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const now = Date.now();

  const tickets = useQuery({
    queryKey: hubKeys.tickets(projectId),
    queryFn: () => {
      if (!client) throw new Error("WorkTab richiede un client autenticato");
      return client.tickets.list({ projectId, statuses: OPEN_TICKET_STATUSES }, undefined, TICKET_ROWS);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const backlog = useQuery({
    queryKey: hubKeys.backlog(projectId),
    queryFn: () => {
      if (!client) throw new Error("WorkTab richiede un client autenticato");
      // Serve solo `total`: nessuno `status` (il server nasconde già
      // convertite e archiviate — sono le voci APERTE) e una riga sola.
      return client.backlog.list({ projectId }, undefined, 1);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const inbox = useQuery({
    queryKey: hubKeys.inbox(projectId),
    queryFn: () => {
      if (!client) throw new Error("WorkTab richiede un client autenticato");
      return client.inbox.list({ projectId }, undefined, INBOX_ROWS);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const toTickets = () => navigation.navigate("Tickets", { projectId, projectName });
  const toBacklog = () => navigation.navigate("ProjectBacklog", { projectId, projectName });
  const toInbox = () => navigation.navigate("ProjectInbox", { projectId, projectName });

  const ticketTotal = tickets.data?.total;
  const ticketItems = tickets.data?.items ?? [];
  const backlogTotal = backlog.data?.total;
  const inboxTotal = inbox.data?.total;
  const inboxItems = inbox.data?.items ?? [];
  const maturity = backlogTotal !== undefined ? backlogSummary(backlogTotal, backlogReadyCount) : null;

  return (
    <View style={styles.column}>
      <View style={styles.block} testID="hub-work-tickets">
        <HubBlockHeader
          title={t("mobile.projects.detail.work.tickets")}
          {...(ticketTotal !== undefined ? { count: t("mobile.projects.detail.work.ticketsCount", { count: ticketTotal }) } : {})}
          seeAllLabel={t("mobile.projects.detail.work.seeAllTickets")}
          onSeeAll={toTickets}
          testID="hub-work-tickets-all"
        />
        <BlockStatus query={tickets} testID="hub-work-tickets" />
        {tickets.isSuccess &&
          (ticketItems.length === 0 ? (
            <EmptyCard text={t("mobile.projects.hub.tickets.empty")} />
          ) : (
            <HubCard>
              {ticketItems.map((item, index) => {
                const age = ticketAge(item.createdAt, now, t);
                return (
                  <HubRow
                    key={item.id}
                    first={index === 0}
                    onPress={() => navigation.navigate("Ticket", { id: item.id, backLabel: projectName })}
                    testID={`hub-work-ticket-${item.id}`}
                  >
                    <Text style={[hubText.title, styles.grow]} numberOfLines={1}>
                      {`#${item.number} ${item.title}`}
                    </Text>
                    {age !== null && <Text style={hubText.trailing}>{age}</Text>}
                  </HubRow>
                );
              })}
            </HubCard>
          ))}
      </View>

      <View style={styles.block} testID="hub-work-backlog">
        <HubBlockHeader
          title={t("mobile.projects.detail.work.backlog")}
          {...(backlogTotal !== undefined ? { count: t("mobile.projects.detail.work.backlogCount", { count: backlogTotal }) } : {})}
          seeAllLabel={t("mobile.projects.detail.work.seeAllBacklog")}
          onSeeAll={toBacklog}
          testID="hub-work-backlog-all"
        />
        <BlockStatus query={backlog} testID="hub-work-backlog" />
        {backlog.isSuccess &&
          (maturity !== null && maturity.total === 0 ? (
            <EmptyCard text={t("mobile.projects.hub.backlog.empty")} />
          ) : (
            <Pressable
              accessibilityRole="button"
              onPress={toBacklog}
              style={({ pressed }) => [styles.backlogCard, pressed && styles.pressed]}
              testID="hub-work-backlog-bar"
            >
              {maturity !== null && (
                <View style={styles.bar}>
                  <View
                    style={[styles.barFill, { width: `${maturity.readyFraction * 100}%` }]}
                    testID="hub-work-backlog-bar-fill"
                  />
                </View>
              )}
              <View style={styles.barLegend}>
                <Text style={styles.ready}>
                  {t("mobile.projects.detail.work.ready", { count: maturity?.ready ?? backlogReadyCount })}
                </Text>
                {maturity !== null && (
                  <Text style={styles.toPrepare}>
                    {t("mobile.projects.detail.work.toPrepare", { count: maturity.toPrepare })}
                  </Text>
                )}
              </View>
            </Pressable>
          ))}
      </View>

      <View style={styles.block} testID="hub-work-inbox">
        <HubBlockHeader
          title={t("mobile.projects.detail.work.notifications")}
          {...(inboxTotal !== undefined ? { count: t("mobile.projects.detail.work.notificationsCount", { count: inboxTotal }) } : {})}
          seeAllLabel={t("mobile.projects.detail.work.seeAllInbox")}
          onSeeAll={toInbox}
          testID="hub-work-inbox-all"
        />
        <BlockStatus query={inbox} testID="hub-work-inbox" />
        {inbox.isSuccess &&
          (inboxItems.length === 0 ? (
            <EmptyCard text={t("mobile.projects.hub.inbox.empty")} />
          ) : (
            <HubCard>
              {inboxItems.map((item, index) => (
                <HubRow
                  key={item.id}
                  first={index === 0}
                  onPress={() => navigation.navigate("Card", { id: item.id, backLabel: projectName })}
                  testID={`hub-work-inbox-${item.id}`}
                >
                  {/*
                    `text` è la riga che la notifica porta con sé — quella che
                    la card mostra in testa. Nessun `title` su questo schema.
                  */}
                  <Text style={[hubText.title, styles.grow]} numberOfLines={1}>
                    {item.text}
                  </Text>
                </HubRow>
              ))}
            </HubCard>
          ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    gap: 24,
  },
  block: {
    gap: 8,
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  muted: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  errorBody: {
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
  },
  backlogCard: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    gap: 10,
    padding: 14,
  },
  pressed: {
    backgroundColor: colors.ink850,
  },
  bar: {
    backgroundColor: colors.ink800,
    borderRadius: 3,
    flexDirection: "row",
    height: 6,
    overflow: "hidden",
  },
  barFill: {
    backgroundColor: colors.ok,
  },
  barLegend: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  ready: {
    color: colors.ok,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  toPrepare: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
});
