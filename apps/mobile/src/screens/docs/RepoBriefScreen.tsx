import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { ApiError } from "@stubwise/api-client";
import type { DocBriefResponse, Reader } from "@stubwise/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useBottomTabBarHeight } from "react-native-bottom-tabs";
import type { ProjectsStackParamList } from "../../app/navigation";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { ScreenHeader } from "../../components/ScreenHeader";
import { SectionLabel } from "../../components/SectionLabel";
import { Skeleton } from "../../components/Skeleton";
import { docsKeys } from "../../lib/docs-mutations";
import { shortDate } from "../../lib/format";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Vedi `InboxScreen.tsx` per il perché di una costante invece di leggere `styles.body.paddingBottom`. */
const CONTENT_BASE_BOTTOM_PADDING = 40;

/**
 * IL BRIEF DI UN REPOSITORY («la documentazione nell'app, come sul web», 25
 * set 2026, design §4), come la tab Brief del web (`DocsBriefView`): cos'è il
 * progetto, per chi, con quali parole, e da quale generazione viene.
 *
 * Un repository senza brief (404) lo dice: non è un errore, la generazione
 * non ne ha ancora prodotto uno. Superficie interna autenticata, come sul web:
 * mostra anche i fatti riservati, che servono proprio all'audit.
 */
export function RepoBriefScreen({ navigation, route }: NativeStackScreenProps<ProjectsStackParamList, "RepoBrief">) {
  const { t } = useTranslation();
  const { client } = useAuth();
  const tabBarHeight = useBottomTabBarHeight();
  const { repositoryId, repositoryName } = route.params;

  const query = useQuery({
    queryKey: docsKeys.brief(repositoryId),
    queryFn: () => {
      if (!client) throw new Error("RepoBriefScreen richiede un client autenticato");
      return client.docs.brief(repositoryId);
    },
    enabled: client !== null,
    staleTime: 5 * 60_000,
  });
  const missing = query.isError && query.error instanceof ApiError && query.error.status === 404;

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: CONTENT_BASE_BOTTOM_PADDING + tabBarHeight }]}
        stickyHeaderIndices={[0]}
      >
        <ScreenHeader
          title={t("mobile.docs.brief.title")}
          subtitle={repositoryName}
          onBack={() => navigation.goBack()}
          backLabel={repositoryName}
        />

        {query.isPending ? (
          <View style={styles.list}>
            <Skeleton height={80} />
            <Skeleton height={120} />
          </View>
        ) : missing ? (
          <Text style={styles.muted} testID="repo-brief-empty">
            {t("mobile.docs.brief.empty")}
          </Text>
        ) : query.isError ? (
          <View style={styles.centered} testID="repo-brief-error">
            <Text style={styles.stateTitle}>{t("mobile.docs.brief.loadError")}</Text>
            <GhostButton label={t("mobile.docs.brief.retry")} onPress={() => void query.refetch()} testID="repo-brief-retry" />
          </View>
        ) : (
          <BriefBody data={query.data} />
        )}
      </ScrollView>
    </View>
  );
}

function BriefBody({ data }: { data: Reader<DocBriefResponse> }) {
  const { t } = useTranslation();
  const { brief, generation, productExclusions } = data;
  return (
    <View style={styles.list}>
      <Text style={styles.generation}>
        {t("mobile.docs.brief.generatedAt", { date: shortDate(generation.createdAt) })}
        {generation.commitSha ? ` · ${t("mobile.docs.brief.commit", { sha: generation.commitSha.slice(0, 7) })}` : ""}
      </Text>

      <Section title={t("mobile.docs.brief.identity")}>
        <Text style={styles.text}>{brief.identity}</Text>
      </Section>

      {brief.actors.length > 0 && (
        <Section title={t("mobile.docs.brief.actors")}>
          {brief.actors.map((actor, index) => (
            <Item key={index} title={actor.name} tag={t(actor.internal ? "mobile.docs.brief.internal" : "mobile.docs.brief.external")}>
              {actor.description}
            </Item>
          ))}
        </Section>
      )}

      {brief.surfaces.length > 0 && (
        <Section title={t("mobile.docs.brief.surfaces")}>
          {brief.surfaces.map((surface, index) => (
            <Item key={index} title={surface.name} tag={t(surface.internal ? "mobile.docs.brief.internal" : "mobile.docs.brief.external")}>
              {`${surface.type} · ${surface.rootPath} · ${surface.audience}`}
            </Item>
          ))}
        </Section>
      )}

      {brief.journeys.length > 0 && (
        <Section title={t("mobile.docs.brief.journeys")}>
          {brief.journeys.map((journey, index) => (
            <Item key={index} title={journey.title} tag={journey.actor}>
              {journey.summary}
            </Item>
          ))}
        </Section>
      )}

      {brief.glossary.length > 0 && (
        <Section title={t("mobile.docs.brief.glossary")}>
          {brief.glossary.map((entry, index) => (
            <Item key={index} title={entry.term}>
              {entry.definition}
            </Item>
          ))}
        </Section>
      )}

      {brief.invariants.length > 0 && (
        <Section title={t("mobile.docs.brief.invariants")}>
          {brief.invariants.map((invariant, index) => (
            <Text key={index} style={styles.text}>{`• ${invariant}`}</Text>
          ))}
        </Section>
      )}

      {brief.existingSources.length > 0 && (
        <Section title={t("mobile.docs.brief.sources")}>
          {brief.existingSources.map((source, index) => (
            <Text key={index} style={styles.mono}>
              {source}
            </Text>
          ))}
        </Section>
      )}

      {brief.confidentialFacts.length > 0 && (
        <Section title={t("mobile.docs.brief.confidential")}>
          {brief.confidentialFacts.map((fact, index) => (
            <Item key={index} title={fact.fact}>
              {fact.reason}
            </Item>
          ))}
        </Section>
      )}

      {productExclusions.length > 0 && (
        <Section title={t("mobile.docs.brief.exclusions")}>
          {productExclusions.map((exclusion, index) => (
            <Item key={index} title={exclusion.title}>
              {exclusion.fact}
            </Item>
          ))}
        </Section>
      )}
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <SectionLabel>{title}</SectionLabel>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Item({ title, tag, children }: { title: string; tag?: string; children: string }) {
  return (
    <View style={styles.item}>
      <View style={styles.itemHead}>
        <Text style={styles.itemTitle}>{title}</Text>
        {tag !== undefined && <Text style={styles.tag}>{tag}</Text>}
      </View>
      <Text style={styles.text}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  body: {
    gap: 12,
    padding: 16,
    paddingBottom: 40,
  },
  list: {
    gap: 12,
  },
  section: {
    gap: 8,
  },
  card: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: radii.card,
    borderWidth: 1,
    gap: 10,
    padding: 14,
  },
  generation: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  text: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  mono: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: 12,
  },
  item: {
    gap: 2,
  },
  itemHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  itemTitle: {
    color: colors.fg,
    flexShrink: 1,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 14,
    fontWeight: "600",
  },
  tag: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: 10,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  muted: {
    color: colors.muted,
    fontFamily: fontFamily.sans,
    fontSize: 14,
    lineHeight: 20,
  },
  centered: {
    alignItems: "center",
    gap: 12,
    paddingVertical: 48,
  },
  stateTitle: {
    color: colors.fg,
    fontFamily: fontFamily.sansSemiBold,
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
});
