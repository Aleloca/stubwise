import type { ProjectListItem, Reader } from "@stubwise/shared";
import notifee from "@notifee/react-native";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useAuth } from "../../app/providers";
import { GhostButton } from "../../components/GhostButton";
import { PrimaryButton } from "../../components/PrimaryButton";
import { SectionLabel } from "../../components/SectionLabel";
import { getPushToken } from "../../lib/push-token";
import { colors } from "../../theme/tokens";
import { fontSize } from "../../theme/typography";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; projects: Reader<ProjectListItem>[] };

/**
 * Onboarding, passo 2 di 2 (canvas `3e`): permesso di notifica + selezione
 * dei progetti da seguire. Monta solo dentro `Auth` DOPO un login riuscito
 * (`RootNavigator` in `app/navigation.tsx`), quindi `useAuth().client` è
 * sempre non-nullo qui — niente client "in attesa di login" da gestire.
 */
export function OnboardingScreen() {
  const { t } = useTranslation();
  const { client, completeOnboarding } = useAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [finishError, setFinishError] = useState(false);

  async function load() {
    if (!client) return;
    setState({ kind: "loading" });
    try {
      const [projects, follows] = await Promise.all([client.projects.list(), client.me.follows()]);
      setSelected(new Set(follows.projectIds));
      setState({ kind: "ready", projects });
    } catch {
      setState({ kind: "error" });
    }
  }

  useEffect(() => {
    // Solo al mount: `client` non cambia mai durante la vita di questo
    // screen (vedi il docblock del componente) e `load` non deve ripartire
    // a ogni toggle di `selected`.
    void load();
  }, []);

  function toggle(projectId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  /**
   * "Attiva le notifiche e inizia" chiede il permesso di sistema PRIMA di
   * registrare il device — "Più tardi" salta SOLO il permesso (e quindi la
   * registrazione, che senza permesso non avrebbe senso), non il salvataggio
   * dei progetti seguiti: chi rimanda le notifiche vuole comunque
   * l'onboarding fatto.
   */
  async function finish(withNotifications: boolean) {
    if (!client) return;
    setBusy(true);
    setFinishError(false);
    try {
      if (withNotifications) {
        await notifee.requestPermission();
        // `getPushToken()` (Task 19: `lib/push-token.ts`) legge il token FCM
        // vero — `null` solo se il SO non l'ha ancora consegnato (permesso
        // appena negato, provider non pronto): niente `registerDevice` con un
        // token fabbricato, che non raggiungerebbe mai nessun device.
        // `lib/push.ts` (`setupPush`, montato da `AppProviders` a ogni avvio
        // autenticato) registra di nuovo lo STESSO token — è un upsert
        // idempotente — e si occupa del refresh e delle categorie; questa
        // chiamata resta perché il permesso lo si chiede solo qui, la prima
        // volta.
        const pushToken = await getPushToken();
        if (pushToken) await client.me.registerDevice(pushToken);
      }
      await client.me.setFollows(Array.from(selected));
      completeOnboarding();
    } catch {
      // Rete instabile appena dopo un login è il caso comune. Senza questo
      // `catch` l'eccezione si propagava come rejection non gestita (il
      // `void finish(...)` nell'`onPress` non la intercetta): `busy` tornava
      // `false` grazie al `finally`, ma l'utente restava sullo screen senza
      // alcun messaggio — sembrava che il bottone non avesse fatto nulla.
      setFinishError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <SectionLabel>{t("mobile.auth.onboarding.step")}</SectionLabel>
      <Text style={styles.title}>{t("mobile.auth.onboarding.title")}</Text>
      <Text style={styles.body}>{t("mobile.auth.onboarding.body")}</Text>

      <View style={styles.listSection}>
        <SectionLabel style={styles.listLabel}>{t("mobile.auth.onboarding.followProjects")}</SectionLabel>

        {state.kind === "loading" ? <Text style={styles.muted}>{t("mobile.common.loading")}</Text> : null}

        {state.kind === "error" ? (
          <View>
            <Text style={styles.muted}>{t("mobile.auth.onboarding.loadError")}</Text>
            <GhostButton label={t("mobile.auth.onboarding.retry")} onPress={() => void load()} />
          </View>
        ) : null}

        {state.kind === "ready" ? (
          <View style={styles.list}>
            {state.projects.map((project) => (
              <View key={project.id} style={styles.row}>
                <Text style={styles.projectName}>{project.name}</Text>
                <Switch
                  accessibilityLabel={project.name}
                  onValueChange={() => toggle(project.id)}
                  thumbColor={colors.ink950}
                  trackColor={{ false: "#242d38", true: colors.signal }}
                  value={selected.has(project.id)}
                />
              </View>
            ))}
          </View>
        ) : null}

        <Text style={styles.settingsHint}>{t("mobile.auth.onboarding.settingsHint")}</Text>
      </View>

      {finishError ? <Text style={styles.errorText}>{t("mobile.auth.onboarding.finishError")}</Text> : null}

      <View style={styles.actions}>
        <PrimaryButton
          disabled={busy || state.kind !== "ready"}
          label={t("mobile.auth.onboarding.activate")}
          onPress={() => void finish(true)}
          testID="onboarding-activate"
        />
        <GhostButton
          disabled={busy || state.kind !== "ready"}
          label={t("mobile.auth.onboarding.later")}
          onPress={() => void finish(false)}
          testID="onboarding-later"
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.ink950,
    flex: 1,
  },
  content: {
    padding: 24,
    paddingTop: 64,
  },
  title: {
    color: colors.fg,
    fontSize: fontSize.title,
    fontWeight: "700",
    marginTop: 10,
  },
  body: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
    marginTop: 8,
  },
  listSection: {
    marginTop: 24,
  },
  listLabel: {
    marginBottom: 8,
  },
  list: {
    backgroundColor: colors.ink900,
    borderColor: colors.line,
    borderRadius: 10,
    borderWidth: 1,
    overflow: "hidden",
  },
  row: {
    alignItems: "center",
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  projectName: {
    color: colors.fg,
    fontSize: 15,
    fontWeight: "600",
  },
  muted: {
    color: colors.muted,
    fontSize: 14,
  },
  settingsHint: {
    color: colors.faint,
    fontSize: 11,
    marginTop: 10,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginTop: 20,
  },
  actions: {
    gap: 6,
    marginTop: 32,
  },
});
