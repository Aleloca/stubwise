import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { isUnknown } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { shortDate } from "../../lib/format";
import { repositoryKeys } from "../../lib/query-keys";
import { colors, radii } from "../../theme/tokens";
import { fontFamily } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * IL DETTAGLIO DI UN REPOSITORY (22 set 2026, hub di progetto, tappa 2):
 * dove sta il codice, su quale branch, con quale account, se il webhook è
 * configurato, cosa esegue la pipeline e se il grafo è acceso.
 *
 * ⚠️ **I file d'ambiente NON ci sono** (design §8): sono segreti, e portarli
 * su un telefono è una decisione di prodotto a sé — non un pezzo mancante di
 * questa schermata. Chi la completa «per simmetria col web» la sta
 * cambiando, non finendo.
 *
 * ⚠️ I comandi di installazione e test invece CI SONO, in sola lettura: non
 * sono segreti e dicono cosa fa la pipeline su questo repo — è il genere di
 * cosa che si vuole poter controllare quando un fix fallisce e si è lontani
 * dal computer.
 *
 * **Nessuna modifica**: configurare un repository si fa da un computer.
 */
export function RepositoryScreen({ navigation, route }: NativeStackScreenProps<ProjectsStackParamList, "Repository">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { slug, projectName } = route.params;

  const query = useQuery({
    queryKey: repositoryKeys.detail(slug),
    queryFn: () => {
      if (!client) throw new Error("RepositoryScreen richiede un client autenticato");
      return client.repositories.get(slug);
    },
    enabled: client !== null,
    staleTime: 60_000,
  });

  const repository = query.data;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={repository?.name ?? slug}
          subtitle={projectName}
          onBack={() => navigation.goBack()}
          backLabel={projectName}
          titleNumberOfLines={2}
        />

        {query.isPending ? (
          <View style={styles.skeletonList} testID="repository-skeleton">
            <Skeleton height={28} width="60%" />
            <Skeleton height={140} />
          </View>
        ) : query.isError ? (
          <View style={styles.centered} testID="repository-error">
            <Text style={styles.errorTitle}>{t("mobile.projects.repository.loadError.title")}</Text>
            <GhostButton
              label={t("mobile.projects.repository.loadError.retry")}
              onPress={() => void query.refetch()}
              testID="repository-retry"
            />
          </View>
        ) : repository === undefined ? null : (
          <>
            <SectionLabel>{t("mobile.projects.repository.sections.where")}</SectionLabel>
            <View style={styles.card}>
              <Field label={t("mobile.projects.repository.fields.url")} value={repository.repoUrl} testID="repository-url" />
              <Field
                label={t("mobile.projects.repository.fields.provider")}
                value={
                  isUnknown(repository.provider)
                    ? t("mobile.projects.repository.fields.providerUnknown")
                    : repository.provider
                }
              />
              <Field label={t("mobile.projects.repository.fields.defaultBranch")} value={repository.defaultBranch} />
              <Field label={t("mobile.projects.repository.fields.gitAccount")} value={repository.gitAccountName} />
              <Field
                label={t("mobile.projects.repository.fields.webhook")}
                value={
                  repository.webhookConfiguredAt === null
                    ? t("mobile.projects.repository.fields.webhookMissing")
                    : t("mobile.projects.repository.fields.webhookConfigured", {
                        date: shortDate(repository.webhookConfiguredAt),
                      })
                }
                testID="repository-webhook"
                last
              />
            </View>

            <SectionLabel style={styles.sectionLabel}>{t("mobile.projects.repository.sections.pipeline")}</SectionLabel>
            <View style={styles.card}>
              {/*
                ⚠️ Un comando ASSENTE si dice, non si nasconde: «nessun
                comando» è un'informazione — quella pipeline non installa (o
                non testa) niente — e una riga che sparisce lascerebbe
                credere che l'abbiamo dimenticata.
              */}
              <Field
                label={t("mobile.projects.repository.fields.installCommand")}
                value={repository.installCommand ?? t("mobile.projects.repository.fields.noCommand")}
                mono
                testID="repository-install-command"
              />
              <Field
                label={t("mobile.projects.repository.fields.testCommand")}
                value={repository.testCommand ?? t("mobile.projects.repository.fields.noCommand")}
                mono
                testID="repository-test-command"
              />
              <Field
                label={t("mobile.projects.repository.fields.graph")}
                value={
                  repository.graphEnabled
                    ? t("mobile.projects.repository.fields.graphOn")
                    : t("mobile.projects.repository.fields.graphOff")
                }
                last
              />
            </View>

            <Text style={styles.readOnlyHint}>{t("mobile.projects.repository.readOnlyHint")}</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Field({
  label,
  value,
  mono = false,
  last = false,
  testID,
}: {
  label: string;
  value: string;
  mono?: boolean;
  last?: boolean;
  testID?: string;
}) {
  return (
    <View style={[styles.field, !last && styles.fieldBorder]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={[styles.fieldValue, mono && styles.fieldValueMono]} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    gap: 8,
    padding: 16,
    paddingBottom: 40,
  },
  sectionLabel: {
    marginTop: 8,
  },
  skeletonList: {
    gap: 12,
  },
  centered: {
    alignItems: "center",
    gap: 12,
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 40,
  },
  errorTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    overflow: "hidden",
  },
  field: {
    gap: 3,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  fieldBorder: {
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
  },
  fieldLabel: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 11,
  },
  fieldValue: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
  },
  fieldValueMono: {
    fontFamily: fontFamily.mono,
    fontSize: 13,
  },
  readOnlyHint: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 4,
  },
});
