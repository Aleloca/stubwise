---
title: Feedback
description: Raccogli feedback dagli utenti con captureFeedback e trasformali in ticket.
---

Oltre agli errori, l'SDK può raccogliere **feedback** espliciti degli utenti —
un messaggio scritto da una persona, non un crash. I feedback diventano ticket
con source `sdk_feedback`.

## `captureFeedback`

Disponibile sia in browser sia in Node:

```js
import { captureFeedback } from "@stubwise/sdk/browser";

captureFeedback({
  message: "Il pulsante di pagamento non risponde su mobile",
  email: "utente@example.com", // opzionale
  url: "/checkout",            // opzionale
});
```

| Campo     | Tipo     | Obbligatorio | Note                                                |
| --------- | -------- | ------------ | --------------------------------------------------- |
| `message` | `string` | Sì           | Il testo del feedback. Un messaggio vuoto è scartato (con un warning). |
| `email`   | `string` | No           | Email di chi scrive, validata come email lato server. |
| `url`     | `string` | No           | La pagina da cui arriva il feedback.                |

Se è impostato un `release` in `init()`, viene allegato automaticamente
all'evento di feedback.

## Un widget di feedback minimale

`captureFeedback` è il mattone su cui costruire un widget. Esempio in browser:

```js
import { captureFeedback } from "@stubwise/sdk/browser";

document.querySelector("#feedback-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  captureFeedback({
    message: form.message.value,
    email: form.email.value || undefined,
    url: location.pathname,
  });
  form.reset();
  // captureFeedback non lancia mai: nessun try/catch necessario.
});
```

Come ogni metodo dell'SDK (a parte `init()` con DSN malformato),
`captureFeedback` **non propaga mai eccezioni** nell'app ospite: puoi chiamarlo
senza guardie. L'evento viene accodato e inviato al prossimo flush.

## Dove finiscono i feedback

Un feedback diventa un ticket nel progetto identificato dal DSN, con tipo
`feedback` e source `sdk_feedback`. Lo gestisci dalla web app come ogni altro
ticket: nel triage AI un feedback vago verrà tipicamente classificato come
`skip`, mentre uno azionabile può entrare nella pipeline. Vedi
[Come funziona la pipeline](/docs/ai-pipeline/how-it-works/).
