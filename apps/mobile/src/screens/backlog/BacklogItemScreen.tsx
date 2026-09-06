import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError } from "@stubwise/api-client";
import type { BacklogItemDetail, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { BacklogStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { PrimaryButton } from "../../components/PrimaryButton";
import { PulseIndicator } from "../../components/PulseIndicator";
import { Skeleton } from "../../components/Skeleton";
import {
  backlogKeys,
  backlogMetaParts,
  backlogStatusLabelKey,
  backlogStatusTone,
  navigateToTicketWork,
  useConvertBacklogItem,
} from "../../lib/backlog-mutations";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/**
 * Dettaglio di sola lettura di una voce (canvas: nessun mockup dedicato —
 * `3a`/`3b`/`3c` coprono lista/cattura/chat, non un "dettaglio"). Raggiunta
 * da `BacklogScreen` SOLO per le voci `converted`/`archived` (chip "Tutti"):
 * sono le uniche card senza azioni proprie in lista (niente Procedi, niente
 * Raffina — vedi il commento su `BacklogListCard`), quindi la card INTERA è
 * lì cliccabile verso questo screen invece che verso un bottone.
 *
 * Lo screen resta comunque completo (documento, metadati, ticket collegati,
 * e — se lo stato lo permette — Procedi/Raffina) e non assume che l'unico
 * modo di arrivarci sia da una voce chiusa: un futuro deep link o un'altra
 * lista potrebbero puntare qui su una voce ancora attiva.
 */
export function BacklogItemScreen({ navigation, route }: NativeStackScreenProps<BacklogStackParamList, "Item">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const { id } = route.params;

  const itemQuery = useQuery({
    queryKey: backlogKeys.item(id),
    queryFn: () => {
      if (!client) throw new Error("BacklogItemScreen richiede un client autenticato");
      return client.backlog.get(id);
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const convert = useConvertBacklogItem();

  const notFound = itemQuery.isError && itemQuery.error instanceof ApiError && itemQuery.error.status === 404;

  return (
    <View style={styles.container}>
      <Pressable onPress={() => navigation.goBack()} testID="backlog-item-back" style={styles.backRow}>
        <Text style={styles.back}>{t("mobile.backlog.item.back")}</Text>
      </Pressable>

      {itemQuery.isPending ? (
        <View style={styles.skeletonList} testID="backlog-item-skeleton">
          <Skeleton height={28} width="70%" />
          <Skeleton height={90} />
          <Skeleton height={140} />
        </View>
      ) : notFound ? (
        <View style={styles.centered} testID="backlog-item-not-found">
          <Text style={styles.errorTitle}>{t("mobile.backlog.item.notFound.title")}</Text>
          <Text style={styles.errorBody}>{t("mobile.backlog.item.notFound.body")}</Text>
        </View>
      ) : itemQuery.isError ? (
        <View style={styles.centered} testID="backlog-item-error">
          <Text style={styles.errorTitle}>{t("mobile.backlog.item.loadError.title")}</Text>
          <GhostButton label={t("mobile.backlog.item.loadError.retry")} onPress={() => void itemQuery.refetch()} testID="backlog-item-retry" />
        </View>
      ) : (
        <ItemBody
          item={itemQuery.data!}
          onProceed={() =>
            convert.mutate(id, {
              onSuccess: (result) => navigateToTicketWork(navigation, result.ticketId),
            })
          }
          proceedPending={convert.isPending}
          convertErrorMessage={convert.errorMessage}
          onRefine={() => navigation.navigate("Chat", { id })}
          onOpenTicket={(ticketId) => navigateToTicketWork(navigation, ticketId)}
        />
      )}
    </View>
  );
}

function ItemBody({
  item,
  onProceed,
  proceedPending,
  convertErrorMessage,
  onRefine,
  onOpenTicket,
}: {
  item: Reader<BacklogItemDetail>;
  onProceed: () => void;
  proceedPending: boolean;
  convertErrorMessage: string | null;
  onRefine: () => void;
  onOpenTicket: (ticketId: string) => void;
}) {
  const { t } = useTranslation();
  // Il dettaglio (`BacklogItemDetail`) non porta `ticketCount` come la lista
  // (`BacklogItem`) — porta `tickets`, l'elenco intero: `.length` è
  // l'equivalente qui.
  const metaText = backlogMetaParts({ ...item, ticketCount: item.tickets.length })
    .map((part) => t(part.key, part.params))
    .join(" · ");
  const isReady = item.status === "ready";
  const canRefine = item.status !== "converted" && item.status !== "archived";

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.title}>{item.title}</Text>
      <View style={styles.metaRow}>
        <PulseIndicator tone={backlogStatusTone(item.status)} text={t(backlogStatusLabelKey(item.status))} />
        <Text style={styles.meta}>{metaText}</Text>
      </View>

      <Text style={styles.document}>{item.document.trim() === "" ? t("mobile.backlog.item.noDocument") : item.document}</Text>

      {(isReady || canRefine) && (
        <View style={styles.actions}>
          {isReady && (
            <View style={styles.proceedButton}>
              <PrimaryButton label={t("mobile.backlog.actions.proceed")} onPress={onProceed} disabled={proceedPending} testID="backlog-item-proceed" />
            </View>
          )}
          {canRefine && (
            <View style={styles.refineButton}>
              <GhostButton label={t("mobile.backlog.actions.refineInChat")} onPress={onRefine} testID="backlog-item-refine" />
            </View>
          )}
        </View>
      )}

      {convertErrorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.errorText} testID="backlog-item-convert-error">
          {convertErrorMessage}
        </Text>
      )}

      {item.tickets.length > 0 && (
        <View style={styles.ticketsBlock}>
          <Text style={styles.ticketsTitle}>{t("mobile.backlog.item.linkedTickets")}</Text>
          {item.tickets.map((ticket) => (
            <Pressable
              key={ticket.id}
              onPress={() => onOpenTicket(ticket.id)}
              style={styles.ticketRow}
              testID={`backlog-item-ticket-${ticket.id}`}
            >
              <Text style={styles.ticketNumber}>#{ticket.number}</Text>
              <Text style={styles.ticketTitle} numberOfLines={1}>
                {ticket.title}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  backRow: {
    paddingHorizontal: 20,
    paddingTop: 56,
  },
  back: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  skeletonList: {
    gap: 12,
    padding: 20,
  },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 8,
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  errorTitle: {
    color: colors.fg,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  errorBody: {
    color: colors.muted,
    fontSize: 14,
    textAlign: "center",
  },
  body: {
    gap: 4,
    padding: 20,
    paddingBottom: 40,
  },
  title: {
    color: colors.fg,
    fontSize: fontSize.title,
    fontWeight: "700",
  },
  metaRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    marginTop: 8,
  },
  meta: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  document: {
    color: colors.muted,
    fontSize: fontSize.body,
    lineHeight: 20,
    marginTop: 14,
  },
  actions: {
    flexDirection: "row",
    gap: 8,
    marginTop: 18,
  },
  proceedButton: {
    flex: 1.6,
  },
  refineButton: {
    flex: 1,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginTop: 10,
  },
  ticketsBlock: {
    marginTop: 22,
  },
  ticketsTitle: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  ticketRow: {
    alignItems: "center",
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.control,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginTop: 6,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  ticketNumber: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  ticketTitle: {
    color: colors.fg,
    flexShrink: 1,
    fontSize: 14,
  },
});
