import { useNavigate, useRouterState, useSearch } from "@tanstack/react-router";
import { useProjects, useSessionPersonId } from "../../data/queries";
import type { ChannelView } from "../../data/types";
import { NewChannelDialog } from "./NewChannelDialog";
import { NewDmDialog } from "./NewDmDialog";

// I dialoghi della Chat sopra qualunque pagina, come «New task»: `?newMessage=1`
// (nuovo messaggio diretto) e `?newChannel=` (`1`, `company` o il codice del
// progetto già scelto). Li aprono la colonna, Browse, ⌘N e la palette.
// Creato il canale (o aperto il DM) ci si arriva: nella sezione Chat del
// progetto se si è lì e il canale è suo, altrimenti nella Chat.

export function ChatDialogsHost() {
  const navigate = useNavigate();
  const me = useSessionPersonId();
  const search = useSearch({ strict: false }) as { newMessage?: string; newChannel?: string };
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const projects = useProjects().data;
  const here = /^\/p\/([^/]+)/.exec(pathname)?.[1];

  const close = (key: "newMessage" | "newChannel") =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({ ...prev, [key]: undefined }),
      replace: true,
    } as never);

  const go = (channel: ChannelView) => {
    const project = projects?.find((p) => p.id === channel.projectId);
    if (here && project?.code === here) {
      void navigate({
        to: "/p/$code/chat/$channelId",
        params: { code: here, channelId: channel.id },
      });
    } else {
      void navigate({ to: "/chat/$channelId", params: { channelId: channel.id } });
    }
  };

  if (search.newMessage === "1") {
    return <NewDmDialog key={me} onOpened={go} onClose={() => close("newMessage")} />;
  }
  if (search.newChannel) {
    return (
      <NewChannelDialog
        key={me}
        initialScope={search.newChannel === "1" ? here : search.newChannel}
        onCreated={go}
        onClose={() => close("newChannel")}
      />
    );
  }
  return null;
}
