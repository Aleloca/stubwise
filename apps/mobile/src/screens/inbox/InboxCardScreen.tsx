import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { InboxStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { InboxCard } from "../../components/inbox/InboxCard";
import { Skeleton } from "../../components/Skeleton";
import { inboxKeys } from "../../lib/inbox-mutations";
import { colors } from "../../theme/tokens";
import { fontSize } from "../../theme/typography";

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
 * errore: non è un guasto, è solo cronologia.
 */
export function InboxCardScreen({ route, navigation }: NativeStackScreenProps<InboxStackParamList, "Card">) {
  const { t } = useTranslation();
  const { client } = useAuth();
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

  return (
    <View style={styles.container} testID="inbox-card-screen">
      <View style={styles.header}>
        <GhostButton label={t("mobile.inbox.notFound.back")} onPress={() => navigation.navigate("List")} testID="inbox-card-back" />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        {query.isPending ? (
          <View testID="inbox-card-skeleton">
            <Skeleton height={180} />
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
  header: {
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingTop: 56,
  },
  content: {
    padding: 16,
  },
  notFound: {
    alignItems: "center",
    paddingTop: 48,
  },
  notFoundTitle: {
    color: colors.fg,
    fontSize: fontSize.body + 2,
    fontWeight: "600",
  },
  notFoundBody: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 6,
    textAlign: "center",
  },
});
