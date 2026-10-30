import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createHashHistory, RouterProvider } from "@tanstack/react-router";
import { StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { roleIdOf } from "../data/access/index";
import { me } from "../data/api";
import { useSetInstanceRole } from "../data/queries";
import { ViewerProvider } from "../data/viewer";
import { useReauth } from "../layout/useReauth";
import { createAppRouter } from "../router";
import { ThemeProvider } from "../theme/ThemeProvider";
import "../styles/index.css";

// SOLO SCREENSHOT (`scripts/capture.mjs`, scene `a9a-entry-reauth*`): l'app
// intera come `App`, più un'azione delicata che parte da sola all'apertura,
// così il dialogo «Confirm it's you» si vede sopra una pagina vera prima che
// le pagine dell'Amministrazione (Task 8) e delle Preferenze (Task 7) lo
// usino. Non è nel build di Electron (che prende solo `index.html`).
//
//   capture/reauth.html?as=p-roberta#/home            cambio di ruolo di Marco
//   capture/reauth.html?as=p-sara&action=token#/home  iscrizione al volo

const params = new URLSearchParams(window.location.search);
const personId = params.get("as") ?? "p-roberta";
const action = params.get("action") ?? "role";

function Trigger() {
  const reauth = useReauth();
  const setRole = useSetInstanceRole();
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const italian = document.documentElement.lang === "it";
    window.setTimeout(() => {
      if (action === "token")
        void reauth(() => me.createToken({ name: "Laptop", expiresAt: null }), {
          action: italian ? "creare un token personale" : "create a personal token",
        });
      else
        void reauth(() => setRole.mutateAsync(["p-marco", roleIdOf("au-1")]), {
          action: italian
            ? "cambiare il ruolo d'istanza di Marco Bellini"
            : "change Marco Bellini's instance role",
        });
    }, 600);
  }, [reauth, setRole]);
  return null;
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const router = createAppRouter(createHashHistory());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <ViewerProvider initialPersonId={personId}>
        <ThemeProvider>
          <RouterProvider router={router} />
          <Trigger />
        </ThemeProvider>
      </ViewerProvider>
    </QueryClientProvider>
  </StrictMode>,
);
