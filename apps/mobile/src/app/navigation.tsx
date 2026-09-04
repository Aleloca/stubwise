import { NavigationContainer, useNavigation } from "@react-navigation/native";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StyleSheet, Text, View } from "react-native";
import { InboxCardScreen } from "../screens/inbox/InboxCardScreen";
import { InboxScreen } from "../screens/inbox/InboxScreen";
import { LoginScreen } from "../screens/auth/LoginScreen";
import { OnboardingScreen } from "../screens/auth/OnboardingScreen";
import { ProjectDetailScreen } from "../screens/projects/ProjectDetailScreen";
import { ProjectsScreen } from "../screens/projects/ProjectsScreen";
import { BacklogChatScreen } from "../screens/backlog/BacklogChatScreen";
import { BacklogItemScreen } from "../screens/backlog/BacklogItemScreen";
import { BacklogScreen } from "../screens/backlog/BacklogScreen";
import { AskProjectScreen } from "../screens/docs/AskProjectScreen";
import { DocsPageScreen } from "../screens/docs/DocsPageScreen";
import { DocsScreen } from "../screens/docs/DocsScreen";
import { WorkScreen } from "../screens/work/WorkScreen";
import { useUnreadCount } from "../lib/inbox-mutations";
import { colors } from "../theme/tokens";
import { fontFamily } from "../theme/typography";
import { buildLinking, getPendingDeepLink, resolveDeepLinkTarget, setPendingDeepLink } from "./linking";
import { useAuth } from "./providers";

export type AuthStackParamList = {
  Login: undefined;
  Onboarding: undefined;
};

export type InboxStackParamList = {
  List: undefined;
  Card: { id: string };
};

export type ProjectsStackParamList = {
  List: undefined;
  Detail: { id: string };
  Ticket: { id: string };
};

/**
 * Stack del tab Backlog (Task 17, canvas `3a`/`3b`/`3c`): lista, dettaglio di
 * sola lettura (voci `converted`/`archived`, raggiunte dal chip "Tutti") e
 * chat di raffinamento. `List` e `Chat` sono le due destinazioni del canvas;
 * `Item` non ha un mockup dedicato — vedi il commento su `BacklogItemScreen`.
 */
export type BacklogStackParamList = {
  List: undefined;
  Item: { id: string };
  Chat: { id: string };
};

/**
 * Stack del tab Docs (Task 18, canvas `3f`): hub (ricerca + «Oppure sfoglia» +
 * entrata di «Chiedi al progetto»), una pagina in markdown e la chat di
 * progetto. `Page` prende `repositoryId`+`slug` (non un id di pagina: è così
 * che `client.docs.page` la vuole, e le "Fonti" di una risposta chat portano
 * esattamente questi due campi) — vedi `DocsScreen.tsx`.
 */
export type DocsStackParamList = {
  List: undefined;
  Page: { repositoryId: string; slug: string };
  Ask: { projectId: string; projectName: string };
};

export type MainTabParamList = {
  Inbox: NavigatorScreenParams<InboxStackParamList>;
  Projects: NavigatorScreenParams<ProjectsStackParamList>;
  Backlog: NavigatorScreenParams<BacklogStackParamList>;
  Docs: NavigatorScreenParams<DocsStackParamList>;
};

export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList>;
  Main: NavigatorScreenParams<MainTabParamList>;
};

const RootStack = createNativeStackNavigator<RootStackParamList>();
const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const InboxStack = createNativeStackNavigator<InboxStackParamList>();
const ProjectsStack = createNativeStackNavigator<ProjectsStackParamList>();
const BacklogStack = createNativeStackNavigator<BacklogStackParamList>();
const DocsStack = createNativeStackNavigator<DocsStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();

function InboxNavigator() {
  return (
    <InboxStack.Navigator screenOptions={{ headerShown: false }}>
      <InboxStack.Screen name="List" component={InboxScreen} />
      <InboxStack.Screen name="Card" component={InboxCardScreen} />
    </InboxStack.Navigator>
  );
}

function ProjectsNavigator() {
  return (
    <ProjectsStack.Navigator screenOptions={{ headerShown: false }}>
      <ProjectsStack.Screen name="List" component={ProjectsScreen} />
      <ProjectsStack.Screen name="Detail" component={ProjectDetailScreen} />
      <ProjectsStack.Screen name="Ticket" component={WorkScreen} />
    </ProjectsStack.Navigator>
  );
}

function BacklogNavigator() {
  return (
    <BacklogStack.Navigator screenOptions={{ headerShown: false }}>
      <BacklogStack.Screen name="List" component={BacklogScreen} />
      <BacklogStack.Screen name="Item" component={BacklogItemScreen} />
      <BacklogStack.Screen name="Chat" component={BacklogChatScreen} />
    </BacklogStack.Navigator>
  );
}

function DocsNavigator() {
  return (
    <DocsStack.Navigator screenOptions={{ headerShown: false }}>
      <DocsStack.Screen name="List" component={DocsScreen} />
      <DocsStack.Screen name="Page" component={DocsPageScreen} />
      <DocsStack.Screen name="Ask" component={AskProjectScreen} />
    </DocsStack.Navigator>
  );
}

/** Sigla mono + etichetta della tab bar, nei due stati del canvas (attiva/spenta). */
function TabGlyph({ code, label, focused }: { code: string; label: string; focused: boolean }) {
  return (
    <View style={styles.tabGlyph}>
      <Text style={[styles.tabCode, { color: focused ? colors.signal : colors.faint }]}>{code}</Text>
      <Text style={[styles.tabLabel, { color: focused ? colors.fg : colors.muted }]}>{label}</Text>
    </View>
  );
}

/**
 * Monta l'app "vera" (autenticata). Al primo render consuma un eventuale
 * deep link rimasto in sospeso da prima del login (vedi
 * `linking.ts`): `Main` è il primo posto in cui gli screen di destinazione
 * (`Inbox/Card`, `Projects/Detail`, `Projects/Ticket`) esistono davvero
 * nell'albero, quindi è anche il primo momento in cui si può navigarci.
 */
function MainNavigator() {
  // Tipizzato sul RootStack (l'ANTENATO di questo componente: `MainNavigator`
  // è il `component` dello screen "Main" del RootStack, non un discendente
  // del proprio `Tab.Navigator`, che ritorna qui sotto): `.navigate("Main",
  // {screen,params})` con i param annidati è il modo corretto di raggiungere
  // uno screen di un navigator FIGLIO da qui, non `.navigate("Inbox", …)`
  // diretto — "Inbox" non è uno screen del RootStack.
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { t } = useTranslation();
  // Il conteggio non letto (campanella web, badge qui): poller di 30s via
  // TanStack Query, vedi `useUnreadCount` in `lib/inbox-mutations.ts`. `0`
  // (o non ancora caricato) non mostra badge — `tabBarBadge` a `0` lo
  // renderebbe comunque (bottom-tabs non nasconde uno "0"), quindi lo si
  // passa come `undefined`.
  const unreadCount = useUnreadCount();
  const badge = unreadCount.data !== undefined && unreadCount.data > 0 ? String(unreadCount.data) : undefined;

  useEffect(() => {
    const pending = getPendingDeepLink();
    if (!pending) return;
    setPendingDeepLink(null);
    const target = resolveDeepLinkTarget(pending);
    if (!target) return;
    if (target.area === "inbox") {
      navigation.navigate("Main", { screen: "Inbox", params: { screen: "Card", params: { id: target.id } } });
    } else if (target.area === "projects") {
      navigation.navigate("Main", { screen: "Projects", params: { screen: "Detail", params: { id: target.id } } });
    } else if (target.area === "tickets") {
      navigation.navigate("Main", { screen: "Projects", params: { screen: "Ticket", params: { id: target.id } } });
    }
  }, [navigation]);

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: styles.tabBar,
        tabBarShowLabel: false,
      }}
    >
      <Tab.Screen
        name="Inbox"
        component={InboxNavigator}
        options={{
          tabBarIcon: ({ focused }) => <TabGlyph code="INB" label={t("mobile.tabs.inbox")} focused={focused} />,
          tabBarBadge: badge,
        }}
      />
      <Tab.Screen
        name="Projects"
        component={ProjectsNavigator}
        options={{
          tabBarIcon: ({ focused }) => <TabGlyph code="PRJ" label={t("mobile.tabs.projects")} focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Backlog"
        component={BacklogNavigator}
        options={{
          tabBarIcon: ({ focused }) => <TabGlyph code="BLG" label={t("mobile.tabs.backlog")} focused={focused} />,
        }}
      />
      <Tab.Screen
        name="Docs"
        component={DocsNavigator}
        options={{
          tabBarIcon: ({ focused }) => <TabGlyph code="DOC" label={t("mobile.tabs.docs")} focused={focused} />,
        }}
      />
    </Tab.Navigator>
  );
}

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Onboarding" component={OnboardingScreen} />
    </AuthStack.Navigator>
  );
}

/**
 * Radice della navigazione: `Auth` (Login → Onboarding) finché
 * `justLoggedIn` non torna `false`, poi `Main`. Vedi il commento su
 * `justLoggedIn` in `providers.tsx` per il perché di questa condizione
 * invece del solo `status`.
 */
export function RootNavigator() {
  const { status, justLoggedIn } = useAuth();
  const isAuthenticated = useMemo(() => () => status === "authenticated" && !justLoggedIn, [status, justLoggedIn]);
  const linking = useMemo(() => buildLinking(isAuthenticated), [isAuthenticated]);

  if (status === "loading") return null;

  const showMain = status === "authenticated" && !justLoggedIn;

  return (
    <NavigationContainer linking={linking}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {showMain ? (
          <RootStack.Screen name="Main" component={MainNavigator} />
        ) : (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.ink900,
    borderTopColor: colors.line,
    borderTopWidth: 1,
  },
  tabGlyph: {
    alignItems: "center",
    gap: 3,
  },
  tabCode: {
    fontFamily: fontFamily.mono,
    fontSize: 12,
    letterSpacing: 2,
  },
  tabLabel: {
    fontSize: 10,
  },
});
