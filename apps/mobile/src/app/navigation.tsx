import { createNavigationContainerRef, NavigationContainer, useNavigation } from "@react-navigation/native";
import type { NavigatorScreenParams } from "@react-navigation/native";
import { createNativeBottomTabNavigator } from "@bottom-tabs/react-navigation";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { SettingsScreen } from "../screens/settings/SettingsScreen";
import { SettingsSectionScreen } from "../screens/settings/SettingsSectionScreen";
import type { SettingsSectionKey } from "../screens/settings/sections";
import { useLogout } from "../screens/settings/use-logout";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { MailDetailSource } from "@stubwise/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { refreshStaleQueries } from "../lib/refresh";
import { useCallback, useEffect, useMemo } from "react";
import type { ImageSourcePropType } from "react-native";
import { Platform } from "react-native";
import type { AppleIcon } from "react-native-bottom-tabs";
import { InboxCardScreen } from "../screens/inbox/InboxCardScreen";
import { GoogleProposalScreen } from "../screens/inbox/GoogleProposalScreen";
import { InboxScreen } from "../screens/inbox/InboxScreen";
import { LoginScreen } from "../screens/auth/LoginScreen";
import { OnboardingScreen } from "../screens/auth/OnboardingScreen";
import { ProjectBacklogScreen } from "../screens/projects/ProjectBacklogScreen";
import { ProjectDetailScreen } from "../screens/projects/ProjectDetailScreen";
import { ProjectInboxScreen } from "../screens/projects/ProjectInboxScreen";
import { ProjectDocsScreen } from "../screens/projects/ProjectDocsScreen";
import { ProjectRepositoriesScreen } from "../screens/projects/ProjectRepositoriesScreen";
import { ProjectMonitorScreen } from "../screens/projects/ProjectMonitorScreen";
import { ProjectRoadmapScreen } from "../screens/projects/ProjectRoadmapScreen";
import { ProjectSettingsScreen } from "../screens/projects/ProjectSettingsScreen";
import { ProjectsScreen } from "../screens/projects/ProjectsScreen";
import { RepositoryScreen } from "../screens/projects/RepositoryScreen";
import { ServerScreen } from "../screens/projects/ServerScreen";
import { ProjectTicketsScreen } from "../screens/projects/ProjectTicketsScreen";
import { BacklogChatScreen } from "../screens/backlog/BacklogChatScreen";
import { BacklogItemScreen } from "../screens/backlog/BacklogItemScreen";
import { BacklogScreen } from "../screens/backlog/BacklogScreen";
import { AskProjectScreen } from "../screens/docs/AskProjectScreen";
import { DocsPageScreen } from "../screens/docs/DocsPageScreen";
import { MailDetailScreen } from "../screens/mbx/MailDetailScreen";
import { MbxScreen } from "../screens/mbx/MbxScreen";
import { MailRejectionsScreen } from "../screens/mbx/MailRejectionsScreen";
import { ThreadDetailScreen } from "../screens/mbx/ThreadDetailScreen";
import { WiseyScreen } from "../screens/wisey/WiseyScreen";
import { WiseyProvider } from "../components/wisey/WiseyProvider";
// Il gufo della tab: un'IMMAGINE a colori, non un SF Symbol. Quale variante
// lo decide `wisey-tab-icon.ts`, in un posto solo.
import { WISEY_TAB_ICON } from "./wisey-tab-icon";
import { WorkScreen } from "../screens/work/WorkScreen";
import { useUnreadCount } from "../lib/inbox-mutations";
import { colors } from "../theme/tokens";
import { fontFamily } from "../theme/typography";
import inboxIcon from "../../assets/icons/inbox.svg";
import folderIcon from "../../assets/icons/folder.svg";
import checklistIcon from "../../assets/icons/checklist.svg";
import mailIcon from "../../assets/icons/mail.svg";
import { buildLinking, getPendingDeepLink, resolveDeepLinkTarget, setPendingDeepLink } from "./linking";
import { useAuth } from "./providers";

export type AuthStackParamList = {
  Login: undefined;
  Onboarding: undefined;
};

/**
 * LE ROTTE DI DETTAGLIO DEL BACKLOG, registrate in DUE stack (22 set 2026,
 * hub di progetto).
 *
 * Non sono un frammento «per riuso»: esistono perché le stesse due schermate
 * si raggiungono da due elenchi diversi — il tab BLG e il backlog DI UN
 * PROGETTO — e da entrambi l'indietro deve riportare all'elenco da cui si è
 * partiti. Registrarle solo in BLG faceva saltare la scheda in basso e
 * riportava alla lista generale, perdendo il progetto.
 *
 * ⚠️ `Chat` sta qui e non è di troppo: `BacklogItemScreen` ci naviga
 * («Raffina in chat»), quindi uno stack che registra `Item` senza `Chat` ha
 * un tap che esplode a runtime. Le due viaggiano insieme.
 */
export type BacklogDetailParamList = {
  Item: { id: string };
  Chat: { id: string };
};

/**
 * La pagina dove si DECIDE su una proposta di posta o calendario (16 set
 * 2026). Non è `Card`: quella mostra la card com'è in elenco ed è il
 * bersaglio dei deep link; qui si sceglie, e la scelta crea roba vera.
 *
 * Registrata in DUE stack dal 22 set 2026, per la stessa ragione di
 * {@link BacklogDetailParamList}: ci si arriva dall'inbox generale e
 * dall'inbox di un progetto, e l'indietro deve tornare dove si era.
 */
export type ProposalParamList = {
  Proposal: { id: string };
};

/**
 * LA PAGINA DI DOCUMENTAZIONE, registrata in DUE stack (22 set 2026, hub di
 * progetto, tappa 2) — terzo frammento dopo {@link BacklogDetailParamList} e
 * {@link ProposalParamList}, e per la stessa identica ragione: ci si arriva
 * dal tab DOC e dalla documentazione DI UN PROGETTO, e da entrambi l'indietro
 * deve riportare dove si era.
 *
 * Dal 25 set 2026 il tab DOC non c'è più («Wisey, anteprima nell'app» §3):
 * la pagina resta registrata nel solo stack dei progetti, e ci arrivano la
 * documentazione del progetto, le «Fonti» della chat e la ricerca globale.
 * Il tipo resta un frammento perché `DocsPageScreen` lo usa per le sue props.
 *
 * ⚠️ Il §5 del design diceva che la documentazione «ha già dove atterrare»
 * perché esiste il tab DOC. È l'unico punto in cui quel documento si
 * contraddice (il §2, la tabella verificata sul codice, dice il contrario):
 * andarci da qui sarebbe il salto fra tab che la tappa 1 ha chiuso.
 *
 * `repositoryId` + `slug` e non un id di pagina: è così che
 * `client.docs.page` la vuole, ed è quello che portano le «Fonti» di una
 * risposta della chat.
 */
export type DocsPageParamList = {
  Page: { repositoryId: string; slug: string };
};

export type InboxStackParamList = {
  List: undefined;
  Card: { id: string };
} & ProposalParamList;

export type ProjectsStackParamList = {
  List: undefined;
  Detail: { id: string };
  /**
   * `backLabel`: il nome del progetto da cui si è arrivati, per la riga
   * «indietro» (21 set 2026). Opzionale perché a un ticket si arriva anche
   * dalla ricerca, dove si entra nello stack Projects e il ripiego
   * «‹ Progetti» è corretto — lì tornare indietro porta davvero alla lista.
   */
  Ticket: { id: string; backLabel?: string };
  /**
   * LE TRE AREE DEL LAVORO DI UN PROGETTO (22 set 2026, hub di progetto,
   * design §5): l'elenco ticket, il backlog e l'inbox, ognuno già filtrato
   * sul progetto da cui si è entrati. Stanno nello stack `Projects` e non
   * nei tab BLG/INB apposta: l'indietro deve tornare all'HUB, e la barra in
   * basso non si sposta — la stessa scelta della riga «‹ STUBWISE» del 21
   * settembre.
   *
   * `projectName` viaggia come PARAMETRO e non si rilegge dal server: serve
   * al titolo e alla riga «indietro», ed è già in mano a chi naviga (l'hub
   * il nome ce l'ha). Stessa scelta di `backLabel` qui sopra.
   */
  Tickets: { projectId: string; projectName: string };
  ProjectBacklog: { projectId: string; projectName: string };
  ProjectInbox: { projectId: string; projectName: string };
  /**
   * DI COSA È FATTO IL PROGETTO (22 set 2026, tappa 2): i repository con il
   * dettaglio di uno, la documentazione e la roadmap. Tutte e quattro in
   * SOLA LETTURA — configurare un repository o amministrare una milestone
   * resta sul web.
   *
   * `Repository` prende lo SLUG e non l'id perché è così che la rotta lo
   * indirizza (`GET /api/repositories/:slug`), ed è quello che porta la
   * proiezione sintetica dentro `projects.get`.
   */
  ProjectRepositories: { projectId: string; projectName: string };
  Repository: { slug: string; projectName: string };
  ProjectDocs: { projectId: string; projectName: string };
  /**
   * «Chiedi al progetto», la chat sulla documentazione (25 set 2026): viveva
   * nel tab DOC, che non c'è più, e ci si arriva ora dalla documentazione del
   * progetto. Parametri invariati.
   */
  Ask: { projectId: string; projectName: string };
  ProjectRoadmap: { projectId: string; projectName: string };
  /**
   * MONITOR E IMPOSTAZIONI (23 set 2026, tappa 3 — l'ultima dell'hub).
   *
   * `Server` prende l'ID: è così che la rotta lo indirizza (`GET
   * /api/servers/:id`). Il monitor è in SOLA LETTURA per tutti: registrare o
   * configurare un server resta sul web.
   *
   * `ProjectSettings` è l'unica schermata dell'hub che SCRIVE, e solo per un
   * maintainer: il gate vero è `requireAdmin` sulla rotta, e l'app mostra il
   * form solo a chi quel gate lo passa.
   */
  ProjectMonitor: { projectId: string; projectName: string };
  Server: { serverId: string; projectName: string };
  ProjectSettings: { projectId: string; projectName: string };
} & BacklogDetailParamList &
  ProposalParamList &
  DocsPageParamList;

/**
 * Stack del tab Backlog (Task 17, canvas `3a`/`3b`/`3c`): lista, dettaglio di
 * sola lettura (voci `converted`/`archived`, raggiunte dal chip "Tutti") e
 * chat di raffinamento. `List` e `Chat` sono le due destinazioni del canvas;
 * `Item` non ha un mockup dedicato — vedi il commento su `BacklogItemScreen`.
 */
export type BacklogStackParamList = {
  List: undefined;
} & BacklogDetailParamList;

/**
 * Stack del tab MBX (Task 7, App M3, Fase C — architettura §3/§6a): posta e
 * calendario, non di un progetto ma di una casella. `List` è lo scambio
 * Posta/Calendario (`MbxScreen.tsx`); `MailDetail` porta al dettaglio di una
 * email (regola 2: dalla notifica si arriva all'oggetto, mai alla lista).
 *
 * Fase D: anche il calendario ha un oggetto da raggiungere, e ci si arriva
 * da `List` con un GIORNO — la griglia carica per intervallo, quindi il
 * giorno è ciò che le serve per sapere quale mese chiedere; l'id
 * dell'appuntamento apre il foglio.
 */
export type MbxStackParamList = {
  /**
   * App M3, Fase D: `List` accetta ora dei PARAMETRI, tutti opzionali —
   * `undefined` resta un valore valido, ed è come ci arriva chi tocca la
   * scheda MBX dalla tab bar. Li porta solo un deep link di calendario
   * (`stubwise://calendar/:day[/:eventId]`): `day` dice alla griglia quale
   * mese caricare e quale giorno aprire, `eventId` quale appuntamento
   * mostrare nel foglio.
   */
  List: { day?: string; eventId?: string } | undefined;
  MailDetail: { source: MailDetailSource; id: string };
  /**
   * Una CONVERSAZIONE letta per intero («la posta si legge per conversazione»
   * §4). `highlightMessageId` (15 set 2026) arriva SOLO dalla ricerca globale
   * e segna il messaggio che ha combaciato: senza, chi apre un risultato deve
   * rileggere lo scambio per capire perché è comparso. Opzionale — chi ci
   * arriva dalla lista o da una notifica non ne ha bisogno.
   */
  ThreadDetail: { threadId: string; highlightMessageId?: string };
  /** Le mail tenute fuori dal cancello, per motivo e dominio (25 set 2026). */
  MailRejections: undefined;
};

export type MainTabParamList = {
  Inbox: NavigatorScreenParams<InboxStackParamList>;
  Projects: NavigatorScreenParams<ProjectsStackParamList>;
  /** Wisey, l'agente dell'istanza (25 set 2026): per ora un'anteprima. */
  Wisey: undefined;
  Backlog: NavigatorScreenParams<BacklogStackParamList>;
  Mbx: NavigatorScreenParams<MbxStackParamList>;
};

export type RootStackParamList = {
  Auth: NavigatorScreenParams<AuthStackParamList>;
  Main: NavigatorScreenParams<MainTabParamList>;
  /**
   * Impostazioni: sul ROOT stack e non dentro una scheda (16 set 2026).
   * L'avatar che ci porta sta nell'intestazione di OGNI schermata, quindi la
   * pagina dev'essere raggiungibile da qualunque scheda senza finire dentro
   * la pila di una sola — e non è una sesta destinazione della barra: è un
   * posto in cui si entra e da cui si torna indietro.
   */
  Settings: undefined;
  /**
   * UNA sola rotta per tutte le sotto-pagine delle Impostazioni, non una per
   * sezione: aggiungerne una domani è una riga nel catalogo
   * (`screens/settings/sections.ts`), non una rotta, un tipo e un import.
   */
  SettingsSection: { section: SettingsSectionKey };
};

/**
 * Il riferimento al contenitore, per chi deve navigare da FUORI di un
 * componente montato dentro un navigatore — oggi solo `AppProviders`, che
 * espone `openSettings()` sul contesto (16 set 2026).
 *
 * ⚠️ Perché non `useNavigation()` dentro `SettingsAvatarButton`, che sarebbe
 * la strada ovvia: quell'hook pretende un `NavigationContainer` sopra di sé,
 * e nessun test di schermata ne monta uno — passarci l'avatar ha rotto 174
 * test su 14 suite in un colpo. Il contesto era già il canale che ogni
 * schermata importa e che ogni test stubba: cambia cosa fa `openSettings`,
 * non chi lo chiama.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

const RootStack = createNativeStackNavigator<RootStackParamList>();
const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const InboxStack = createNativeStackNavigator<InboxStackParamList>();
const ProjectsStack = createNativeStackNavigator<ProjectsStackParamList>();
const BacklogStack = createNativeStackNavigator<BacklogStackParamList>();
const MbxStack = createNativeStackNavigator<MbxStackParamList>();
const Tab = createNativeBottomTabNavigator<MainTabParamList>();

function InboxNavigator() {
  return (
    <InboxStack.Navigator screenOptions={{ headerShown: false }}>
      <InboxStack.Screen name="List" component={InboxScreen} />
      <InboxStack.Screen name="Card" component={InboxCardScreen} />
      <InboxStack.Screen name="Proposal" component={GoogleProposalScreen} />
    </InboxStack.Navigator>
  );
}

function ProjectsNavigator() {
  return (
    <ProjectsStack.Navigator screenOptions={{ headerShown: false }}>
      <ProjectsStack.Screen name="List" component={ProjectsScreen} />
      <ProjectsStack.Screen name="Detail" component={ProjectDetailScreen} />
      <ProjectsStack.Screen name="Ticket" component={WorkScreen} />
      <ProjectsStack.Screen name="Tickets" component={ProjectTicketsScreen} />
      <ProjectsStack.Screen name="ProjectBacklog" component={ProjectBacklogScreen} />
      <ProjectsStack.Screen name="ProjectInbox" component={ProjectInboxScreen} />
      {/*
        LE STESSE TRE SCHERMATE DI BLG E INB, registrate una seconda volta
        (22 set 2026). Una sola COPIA del componente, due registrazioni: una
        seconda copia in un file nuovo sarebbe la divergenza che questo repo
        insegue ovunque. Le schermate non sanno in quale stack stanno girando
        — sono tipate sui frammenti `BacklogDetailParamList`/
        `ProposalParamList`, non su uno stack intero — e non esiste nessun
        ramo che lo chieda.

        Servono perché senza, aprire una voce di backlog o decidere una
        proposta dall'hub usciva dallo stack `Projects`: la scheda in basso
        saltava, e l'indietro riportava alla lista GENERALE invece che
        all'elenco di quel progetto.
      */}
      <ProjectsStack.Screen name="Item" component={BacklogItemScreen} />
      <ProjectsStack.Screen name="Chat" component={BacklogChatScreen} />
      <ProjectsStack.Screen name="Proposal" component={GoogleProposalScreen} />
      <ProjectsStack.Screen name="ProjectRepositories" component={ProjectRepositoriesScreen} />
      <ProjectsStack.Screen name="Repository" component={RepositoryScreen} />
      <ProjectsStack.Screen name="ProjectDocs" component={ProjectDocsScreen} />
      <ProjectsStack.Screen name="ProjectRoadmap" component={ProjectRoadmapScreen} />
      <ProjectsStack.Screen name="ProjectMonitor" component={ProjectMonitorScreen} />
      <ProjectsStack.Screen name="Server" component={ServerScreen} />
      <ProjectsStack.Screen name="ProjectSettings" component={ProjectSettingsScreen} />
      <ProjectsStack.Screen name="Page" component={DocsPageScreen} />
      <ProjectsStack.Screen name="Ask" component={AskProjectScreen} />
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

function MbxNavigator() {
  return (
    <MbxStack.Navigator screenOptions={{ headerShown: false }}>
      <MbxStack.Screen name="List" component={MbxScreen} />
      <MbxStack.Screen name="MailDetail" component={MailDetailScreen} />
      <MbxStack.Screen name="ThreadDetail" component={ThreadDetailScreen} />
      <MbxStack.Screen name="MailRejections" component={MailRejectionsScreen} />
    </MbxStack.Navigator>
  );
}

/**
 * Icona nativa per tab (Task 6, App M1+M2, 11 set 2026): SF Symbol su iOS —
 * nessuna immagine caricata, resa dal sistema e per questo automaticamente
 * coerente col Liquid Glass di iOS 26 — Material Symbol (SVG) su Android,
 * decodificato nativamente dal `TabView` (Coil-svg, verificato nel
 * `build.gradle` della libreria). Scelti verificando prima l'esistenza di
 * entrambi, non a memoria: i quattro SF Symbol contro i tipi di
 * `sf-symbols-typescript` (dipendenza reale di `react-native-bottom-tabs`,
 * `AppleIcon["sfSymbol"]` qui sotto fa da controllo a compile-time sugli
 * stessi tipi), i quattro Material Symbol contro il repo ufficiale
 * `google/material-design-icons` (HTTP 200 su ognuno prima del download).
 *
 * Scelta finale (riferita a Fable/maintainer): Inbox → `tray.fill` /
 * `inbox`, Projects → `folder.fill` / `folder`, Backlog → `checklist` /
 * `checklist`, Docs → `book.fill` / `menu_book` (tab tolta il 25 set 2026),
 * **MBX → `envelope.fill` /
 * `mail`** (Task 7, App M3, Fase C, 11 set 2026 — busta, per l'architettura
 * §6a: verificato `'envelope.fill'` contro `sf-symbols-typescript@2.2.0`
 * — presente dalla versione 1.0, la più compatibile — e `mail_fill1_24px.svg`
 * scaricato da `google/material-design-icons` dopo un HTTP 200, stessa
 * disciplina delle altre quattro).
 */
function nativeTabIcon(
  sfSymbol: AppleIcon["sfSymbol"],
  androidIcon: ImageSourcePropType,
): AppleIcon | ImageSourcePropType {
  return Platform.OS === "ios" ? { sfSymbol } : androidIcon;
}

/**
 * L'area autenticata: le schede, dentro lo store di Wisey (design §10). Il
 * provider sta SOPRA il navigatore delle schede perché lo leggono sia la
 * pagina Wisey sia la sua icona nella barra, che `MainTabs` disegna — e un
 * componente non legge il contesto che rende lui stesso.
 */
function MainNavigator() {
  return (
    <WiseyProvider>
      <MainTabs />
    </WiseyProvider>
  );
}

/**
 * Monta l'app "vera" (autenticata). Al primo render consuma un eventuale
 * deep link rimasto in sospeso da prima del login (vedi
 * `linking.ts`): `Main` è il primo posto in cui gli screen di destinazione
 * (`Inbox/Card`, `Projects/Detail`, `Projects/Ticket`, `Mbx/MailDetail`,
 * `Mbx/List` col giorno del calendario) esistono davvero nell'albero, quindi
 * è anche il primo momento in cui si può navigarci.
 */
function MainTabs() {
  // Tipizzato sul RootStack (l'ANTENATO di questo componente: `MainNavigator`
  // è il `component` dello screen "Main" del RootStack, non un discendente
  // del proprio `Tab.Navigator`, che ritorna qui sotto): `.navigate("Main",
  // {screen,params})` con i param annidati è il modo corretto di raggiungere
  // uno screen di un navigator FIGLIO da qui, non `.navigate("Inbox", …)`
  // diretto — "Inbox" non è uno screen del RootStack.
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
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
    } else if (target.area === "mail") {
      navigation.navigate("Main", {
        screen: "Mbx",
        params: { screen: "MailDetail", params: { source: target.source, id: target.id } },
      });
    } else if (target.area === "calendar") {
      navigation.navigate("Main", {
        screen: "Mbx",
        params: {
          screen: "List",
          params: { day: target.day, ...(target.eventId ? { eventId: target.eventId } : {}) },
        },
      });
    }
  }, [navigation]);

  return (
    // Task 6: niente più `screenOptions.headerShown`/`tabBarShowLabel` — il
    // tipo nativo (`NativeBottomTabNavigationOptions`) non li conosce
    // nemmeno: questo navigator non disegna un header proprio (ogni stack
    // figlio già lo sopprime da sé, vedi `*Navigator` sopra) e l'etichetta è
    // SEMPRE nativa, non un'opzione da nascondere. `tabBarInactiveTintColor`
    // resta impostato: è documentato IGNORATO da iOS ≥26 (Liquid Glass
    // decide da sé), ma Android lo onora davvero — non è un tentativo di
    // compensare l'ignoto su iOS, è l'uso previsto della stessa prop sulle
    // due piattaforme. Deliberatamente NON impostato
    // `experimental_bakedTintColors`: è il workaround che "cuoce" il colore
    // nell'icona su iOS 26, con gli effetti collaterali che la libreria
    // stessa documenta (badge mal posizionati, accessibilità) — la
    // decisione del maintainer è lasciare che il sistema decida.
    <Tab.Navigator
      tabBarActiveTintColor={colors.signal}
      tabBarInactiveTintColor={colors.faint}
      tabBarStyle={{ backgroundColor: colors.ink900 }}
      tabLabelStyle={{ fontFamily: fontFamily.mono, fontSize: 12 }}
    >
      <Tab.Screen
        name="Inbox"
        component={InboxNavigator}
        options={{
          tabBarLabel: "INB",
          tabBarIcon: () => nativeTabIcon("tray.fill", inboxIcon),
          tabBarBadge: badge,
        }}
      />
      <Tab.Screen
        name="Projects"
        component={ProjectsNavigator}
        options={{
          tabBarLabel: "PRJ",
          tabBarIcon: () => nativeTabIcon("folder.fill", folderIcon),
        }}
      />
      {/*
        WISEY al CENTRO (25 set 2026, design §2). Il rilievo lo dà il COLORE,
        non la misura: la barra resta quella nativa. `original` è ciò che
        tiene il gufo a colori — senza, iOS ricolora l'immagine con la tinta
        della barra e ne fa una sagoma. Stessa icona da selezionata e non.
        La tab iniziale resta Inbox: aprire l'app su un'anteprima sarebbe
        sbagliato.
      */}
      <Tab.Screen
        name="Wisey"
        component={WiseyScreen}
        options={{
          tabBarLabel: "WISEY",
          tabBarIcon: () => WISEY_TAB_ICON,
          tabBarIconRenderingMode: "original",
        }}
      />
      <Tab.Screen
        name="Backlog"
        component={BacklogNavigator}
        options={{
          tabBarLabel: "BLG",
          tabBarIcon: () => nativeTabIcon("checklist", checklistIcon),
        }}
      />
      <Tab.Screen
        name="Mbx"
        component={MbxNavigator}
        options={{
          tabBarLabel: "MBX",
          tabBarIcon: () => nativeTabIcon("envelope.fill", mailIcon),
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
 * IL RITORNO SU UNA SCHERMATA, per TUTTE le schermate (23 set 2026 — design
 * «l'app non resta indietro», §3).
 *
 * A ogni cambio di navigazione — tornare indietro, cambiare scheda, aprire
 * una schermata — si ricaricano le query MONTATE e SCADUTE (oltre il loro
 * `staleTime`). Quelle fresche non si toccano.
 *
 * ⚠️ **Un punto solo, non un hook per schermata.** La forma che si trova
 * nella documentazione di TanStack per React Native è un `useRefreshOnFocus`
 * da chiamare in ogni schermata: è la fragilità che questo lavoro esiste per
 * togliere. Le tre scoperte della settimana del 22 settembre — le chiavi
 * dell'hub, `useTicketAction`, il polso — erano tutte la stessa cosa: un
 * punto che qualcuno doveva ricordarsi e non l'ha fatto. Qui non c'è niente
 * da ricordare: vale per le schermate di oggi e per quelle che verranno.
 *
 * ⚠️ **Il costo, dichiarato.** «Montate» vuol dire più della schermata in
 * vista: le schermate SOTTO nello stack restano montate, e la barra in basso
 * tiene montate anche le altre SCHEDE già visitate. Le loro query scadute si
 * ricaricano anche loro. È spreco limitato — solo query più vecchie del loro
 * `staleTime`, e un'app con cinque schede e stack di due o tre livelli — e
 * filtrarle per schermata richiederebbe di sapere, da qui, quale query
 * appartiene a quale rotta: non c'è un modo pulito.
 *
 * ⚠️ **Non basta da solo.** Il ricaricamento rispetta lo `staleTime`: chi
 * approva un piano e torna indietro in tre secondi trova dati «non vecchi», e
 * non si ricarica niente. Per quello le mutazioni condivise dichiarano cosa
 * hanno cambiato (`useTicketAction`, `useDecision`, …): sono due rimedi a due
 * cause diverse, e servono entrambi.
 *
 * Le due regole fini — riusare la richiesta in volo, e non ricaricare
 * mentre una mutazione OTTIMISTICA è in corso — stanno in `refreshStaleQueries`
 * (`lib/refresh.ts`), dove si provano da sole.
 */
function useRefreshOnNavigation(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void refreshStaleQueries(queryClient);
  }, [queryClient]);
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
  const refreshOnNavigation = useRefreshOnNavigation();

  if (status === "loading") return null;

  const showMain = status === "authenticated" && !justLoggedIn;

  return (
    <NavigationContainer linking={linking} ref={navigationRef} onStateChange={refreshOnNavigation}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {showMain ? (
          <>
            <RootStack.Screen name="Main" component={MainNavigator} />
            <RootStack.Screen name="Settings" component={SettingsRoute} />
            <RootStack.Screen name="SettingsSection" component={SettingsSectionRoute} />
          </>
        ) : (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}

/**
 * Le Impostazioni sul root stack: prende dal contesto ciò che la pagina non
 * può avere dai `route.params` (client, utente, e il modo di dire all'app
 * che la sessione è finita) e le passa il ritorno indietro.
 *
 * Il `null` quando client o utente mancano non è difensivo a caso: questa
 * rotta esiste solo nel ramo autenticato del root stack, quindi è un caso
 * che non si verifica — ma renderizzare un componente che li pretende
 * sarebbe un crash invece di una schermata vuota per un istante.
 */
function SettingsRoute({ navigation }: NativeStackScreenProps<RootStackParamList, "Settings">) {
  const { client, user, loggedOut } = useAuth();
  const { logout, loggingOut } = useLogout(client, loggedOut);
  if (client === null || user === null) return null;
  return (
    <SettingsScreen
      user={user}
      onOpenSection={(section) => navigation.navigate("SettingsSection", { section })}
      onBack={() => navigation.goBack()}
      onLogout={logout}
      loggingOut={loggingOut}
    />
  );
}

/** Una sotto-pagina delle Impostazioni: quale, lo dice il parametro. */
function SettingsSectionRoute({
  navigation,
  route,
}: NativeStackScreenProps<RootStackParamList, "SettingsSection">) {
  const { client, user } = useAuth();
  if (client === null || user === null) return null;
  return (
    <SettingsSectionScreen
      section={route.params.section}
      client={client}
      user={user}
      onBack={() => navigation.goBack()}
    />
  );
}
