import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { InboxStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { InboxCard } from "../../components/inbox/InboxCard";
import { Skeleton } from "../../components/Skeleton";
import { SettingsAvatarButton } from "../../components/SettingsAvatarButton";
import { inboxKeys } from "../../lib/inbox-mutations";
import { colors } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.content.padding`. */
const CONTENT_BASE_BOTTOM_PADDING = 16;

/**
 * Una card d'inbox da sola, fuori dalla lista: destinazione del deep link
 * `stubwise://inbox/{id}` (push, widget) e di "tocca per aprire la card in
 * Inbox" dal widget di sistema. Legge dalla STESSA query della lista
 * (`inboxKeys.list()`, condivisa via TanStack Query) invece di una rotta
 * dedicata — `GET /api/inbox` non ha un endpoint per-riga — così apre
 * all'istante se la lista è già in cache e altrimenti la scarica lei stessa.
 *
 * Se la riga non c'è più (gestita o rinviata nel frattempo da qualcun altro,
 * o un deep link su un id ormai scaduto) mostra un avviso invece di un
 * errore: non è un guasto, è solo cronologia. ⚠️ Ma questo vale SOLO quando
 * la query è riuscita e la riga semplicemente non c'è (`query.isError ===
 * false`): un fallimento di RETE deve restare distinto — "non trovata"
 * implicherebbe "gestita da qualcun altro", un esito rassicurante che su un
 * deep link push (il caso più probabile di rete ballerina: notifica appena
 * arrivata, tap immediato) sarebbe fuorviante. Stesso pattern isPending →
 * isError → dato di `InboxScreen.tsx`, copiato di proposito: due schermate,
 * un solo modo di distinguere "non è successo niente" da "non ho potuto
 * controllare".
 */
export function InboxCardScreen({ route, navigation }: NativeStackScreenProps<InboxStackParamList, "Card">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { id } = route.params;

  const projectsQuery = useQuery({
    queryKey: ["projects", "list"],
    queryFn: () => {
      if (!client) throw new Error("InboxCardScreen richiede un client autenticato");
      return client.projects.list();
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const query = useQuery({
    queryKey: inboxKeys.list(),
    queryFn: () => {
      if (!client) throw new Error("InboxCardScreen richiede un client autenticato");
      return client.inbox.list();
    },
    enabled: client !== null,
    staleTime: 10_000,
  });

  const item = query.data?.items.find((row) => row.id === id);
  const projectsById = new Map((projectsQuery.data ?? []).map((project) => [project.id, project.name]));
  const projectName = item ? (item.projectId !== null ? projectsById.get(item.projectId) : item.pulse?.projectName) : undefined;

  // Task 7 (App M1+M2, 11 set 2026): l'header (il bottone "indietro") è
  // dentro lo `ScrollView`, non più fratello — stesso schema di
  // `InboxScreen.tsx`. Fix di review (Task 2, 11 set 2026): l'avatar,
  // mancante del tutto su questo screen, ora c'è — sulla STESSA riga del
  // bottone "indietro" — e la riga è ancorata (`stickyHeaderIndices`,
  // vedi `ScreenHeader.tsx`) così le Impostazioni restano raggiungibili
  // anche scorrendo.
  return (
    <View style={styles.container} testID="inbox-card-screen">
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <View style={styles.header}>
          <GhostButton label={t("mobile.inbox.notFound.back")} onPress={() => navigation.navigate("List")} testID="inbox-card-back" />
          <SettingsAvatarButton />
        </View>
        {query.isPending ? (
          <View testID="inbox-card-skeleton">
            <Skeleton height={180} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="inbox-card-error">
            <Text style={styles.notFoundTitle}>{t("mobile.inbox.loadError.title")}</Text>
            <View style={styles.retryButton}>
              <GhostButton
                label={t("mobile.inbox.loadError.retry")}
                onPress={() => void query.refetch()}
                testID="inbox-card-retry"
              />
            </View>
          </View>
        ) : item !== undefined ? (
          <InboxCard item={item} projectName={projectName} />
        ) : (
          <View style={styles.notFound} testID="inbox-card-not-found">
            <Text style={styles.notFoundTitle}>{t("mobile.inbox.notFound.title")}</Text>
            <Text style={styles.notFoundBody}>{t("mobile.inbox.notFound.body")}</Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  // Fix di review (Task 2, 11 set 2026): `header` ora porta ANCHE l'avatar,
  // sulla stessa riga del bottone "indietro" — `paddingTop`/`backgroundColor`
  // propri perché la riga è ANCORATA (`stickyHeaderIndices` sullo
  // `ScrollView` sotto): senza uno sfondo opaco, il contenuto sotto
  // l'attraverserebbe scorrendo. `content` non porta più `paddingTop`: lo
  // ha spostato qui `header`, o si sommerebbero (era il bug già preso e
  // corretto nel Task 7 su altre schermate — vedi `ProjectDetailScreen.tsx`).
  header: {
    alignItems: "center",
    backgroundColor: colors.ink950,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 12,
    paddingTop: 56,
  },
  content: {
    padding: 16,
  },
  notFound: {
    alignItems: "center",
    paddingTop: 48,
  },
  centered: {
    alignItems: "center",
    paddingTop: 48,
  },
  retryButton: {
    marginTop: 16,
  },
  notFoundTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: fontSize.body + 2,
    fontWeight: "600",
  },
  notFoundBody: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    marginTop: 6,
    textAlign: "center",
  },
});
