-- Fase 6c — configurazione d'istanza dell'ammissione della posta. Tutto
-- additivo, nessun valore di enum nuovo, quindi un solo batch: tre colonne
-- nuove sul singleton `instance_settings`, tutte con default.
--
-- L'ammissione (è lavoro?) è separata dall'attribuzione (di quale progetto?),
-- che resta governata da `project_email_routes` (fase 6) e non cambia qui.
-- I default sono scelti per NON restringere il comportamento di ammissione
-- esistente per chi ha già regole di progetto configurate: sono
-- un allargamento del perimetro (i domini dei propri Workspace ammettono
-- senza bisogno di una regola per progetto), mai una restrizione — una
-- regola di progetto che oggi ammette un messaggio continua ad ammetterlo
-- domani, indipendentemente da questi campi.
ALTER TABLE "instance_settings"
  -- I mittenti (o destinatari in copia) dei domini di un Google Workspace
  -- registrato ammettono la posta anche senza una regola di progetto. Default
  -- true: è un allargamento, non un restringimento, dell'ammissione di oggi.
  ADD COLUMN "email_admit_workspace_domains" boolean DEFAULT true NOT NULL,
  -- Etichette Gmail che escludono SEMPRE, anche se una regola di progetto o il
  -- dominio del Workspace ammetterebbero: le esclusioni vincono sempre.
  ADD COLUMN "email_admission_deny_labels" text[] DEFAULT '{CATEGORY_PROMOTIONS,CATEGORY_SOCIAL,SPAM}' NOT NULL,
  -- Scarta la posta automatica (List-Unsubscribe, List-Id, Precedence: bulk,
  -- Auto-Submitted diverso da "no"). Default true: prima di questa fase il
  -- poller non aveva alcuna difesa contro le mailing list e le notifiche
  -- automatiche di un dominio Workspace, quindi il default onesto è "scarta".
  ADD COLUMN "email_admission_deny_automated" boolean DEFAULT true NOT NULL;
