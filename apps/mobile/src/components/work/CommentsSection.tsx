import type { CommentReplyTo, PublicUser, Reader, TicketComment } from "@stubwise/shared";
import { isUnknown, plainExcerpt } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { useAddComment } from "../../lib/work-mutations";
import { SafeMarkdown } from "../SafeMarkdown";
import { relativeTimeCompact } from "../../lib/format";
import { colors, radii } from "../../theme/tokens";
import { fontFamily, fontSize } from "../../theme/typography";

/** Tetto del server su un commento (`createCommentBodySchema`). */
const COMMENT_MAX_CHARS = 20_000;

/**
 * La conversazione attorno al lavoro, in DUE pezzi che la tab Attività dispone
 * separati: il campo per scrivere ({@link CommentComposer}) in cima, la
 * «Storia del lavoro» (`TicketHistory`) subito sotto, e l'elenco
 * ({@link CommentList}) in fondo.
 *
 * ⚠️ **L'elenco non è decorazione del campo di invio: è ciò che lo rende
 * verificabile.** Prima di questo blocco l'app non mostrava i commenti da
 * nessuna parte — la storia non li include (sono qui sotto), e
 * `ticketActivityEntrySchema` spoglia deliberatamente autore e corpo di un
 * commento («nessuno li legge», dice il suo docblock). Un campo di invio da
 * solo avrebbe lasciato chi scrive senza sapere se è andata.
 *
 * Ordine e posizione decisi dal maintainer il 5 ott 2026, provando l'app: il
 * campo e la storia in cima (prima stavano sotto l'elenco, troppo in basso),
 * e i commenti dal PIÙ RECENTE — il server li manda dal più vecchio, quindi
 * l'elenco li rovescia. Il corpo è markdown (i commenti dell'AI e di sistema
 * lo usano): passa da `SafeMarkdown`, con la guardia sui link.
 *
 * Un commento dell'AI o di sistema non ha un autore da nominare
 * (`authorId: null`): porta l'etichetta della sua origine invece di un'email
 * inventata.
 *
 * **Risposte (5 ott 2026, piano B4).** «Rispondi» su un commento dell'elenco
 * mette sopra il campo «Rispondendo a {nome}: “estratto” ✕» (lo stato vive in
 * `WorkScreen`, che possiede entrambi i pezzi); l'invio porta
 * `replyToCommentId` e azzera la risposta. Una risposta mostra sopra il corpo
 * «In risposta a {nome}: “estratto”», premibile — scorre all'originale — solo
 * se l'originale è nell'elenco. Si risponde a qualunque commento del ticket,
 * anche dell'agente o di sistema (D7).
 */
export function CommentComposer({
  ticketId,
  replyingTo = null,
  replyingToName = null,
  onCancelReply,
  onSent,
}: {
  ticketId: string;
  /**
   * Il commento a cui si sta rispondendo, o `null`. Con una risposta il campo
   * si apre SOTTO quel commento (5 ott 2026, decisione del maintainer provando
   * l'app: chi risponde ha sotto gli occhi il testo a cui risponde, e la
   * pagina non salta in cima). Ha `testID` suoi (`work-reply-*`): il campo in
   * cima resta montato accanto.
   */
  replyingTo?: Reader<TicketComment> | null;
  /** Il nome da mostrare per quel commento (deciso da chi ha l'elenco degli utenti). */
  replyingToName?: string | null;
  onCancelReply?: () => void;
  /** Dopo l'invio: chi possiede lo stato della risposta lo azzera. */
  onSent?: () => void;
}) {
  const reply = replyingTo !== null;
  const id = (name: string) => (reply ? `work-reply-${name}` : `work-comment-${name}`);
  const { t } = useTranslation();
  const add = useAddComment(ticketId);
  const [draft, setDraft] = useState("");

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= COMMENT_MAX_CHARS && !add.disabled;

  /**
   * Bozza e risposta in corso si azzerano SOLO a invio riuscito: con un 422
   * (`reply_target_invalid`) o la rete giù chi scriveva ritrova testo e
   * destinatario, e l'errore sotto il campo dice perché.
   */
  function send(): void {
    if (!canSend) return;
    add.mutate(replyingTo === null ? { body: trimmed } : { body: trimmed, replyToCommentId: replyingTo.id }, {
      onSuccess: () => {
        setDraft("");
        onSent?.();
      },
    });
  }

  return (
    <View testID={reply ? "work-reply-composer" : "work-comment-composer"} style={reply ? styles.replyComposer : undefined}>
      <View style={styles.composer}>
        <TextInput
          // A chi si sta rispondendo lo dice l'ETICHETTA del campo: «Reply»
          // porta il fuoco qui, quindi lo screen reader legge proprio questa.
          accessibilityLabel={
            reply
              ? t("mobile.work.comments.inputReplying", {
                  name: replyingToName ?? t("mobile.work.comments.authorUnknown"),
                })
              : t("mobile.work.comments.placeholder")
          }
          autoFocus={reply}
          value={draft}
          onChangeText={setDraft}
          editable={!add.disabled}
          multiline
          placeholder={
            reply
              ? t("mobile.work.comments.inputReplying", {
                  name: replyingToName ?? t("mobile.work.comments.authorUnknown"),
                })
              : t("mobile.work.comments.placeholder")
          }
          placeholderTextColor={colors.faint}
          style={styles.input}
          testID={id("input")}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.work.comments.send")}
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={send}
          style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
          testID={id("send")}
        >
          <Text style={styles.sendButtonLabel}>↑</Text>
        </Pressable>
      </View>
      {reply && (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={onCancelReply}
          style={styles.replyCancel}
          testID="work-reply-cancel"
        >
          <Text style={styles.replyCancelLabel}>{t("mobile.work.comments.cancelReply")}</Text>
        </Pressable>
      )}

      {add.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.error} testID={id("error")}>
          {add.errorMessage}
        </Text>
      )}
      {!add.online && (
        <Text style={styles.offline} testID={id("offline")}>
          {t("mobile.work.comments.offline")}
        </Text>
      )}
    </View>
  );
}

export function CommentList({
  ticketId,
  viewerId = null,
  comments,
  users,
  replyingToId = null,
  onReply,
  onCancelReply,
  onJumpTo,
  onRowLayout,
}: {
  ticketId: string;
  /** Chi guarda: le sue risposte si leggono «La tua risposta». */
  viewerId?: string | null;
  /** Il commento sotto cui è aperto il campo della risposta, o `null`. */
  replyingToId?: string | null;
  onCancelReply?: () => void;
  /** `undefined` finché la query non ha risposto, o se è fallita. */
  comments: Reader<TicketComment>[] | undefined;
  /** Per dare un nome all'autore di un commento; `undefined` se l'elenco non è arrivato. */
  users: Reader<PublicUser>[] | undefined;
  /** «Rispondi» su un commento; senza, il bottone non c'è. */
  onReply?: (comment: Reader<TicketComment>) => void;
  /** Tocco sulla riga «In risposta a …» di un originale presente nell'elenco. */
  onJumpTo?: (commentId: string) => void;
  /** La posizione di ogni riga DENTRO l'elenco, per scorrere all'originale. */
  onRowLayout?: (commentId: string, y: number) => void;
}) {
  const { t } = useTranslation();
  const present = new Set((comments ?? []).map((comment) => comment.id));
  // Le risposte ricevute da ogni commento, dalla più recente: compaiono come
  // card SOTTO l'originale (5 ott 2026, maintainer: «non si capisce che la
  // risposta è stata aggiunta» — la risposta va in cima all'elenco, lontano
  // dal commento a cui risponde).
  const repliesOf = new Map<string, Reader<TicketComment>[]>();
  for (const comment of newestFirst(comments ?? [])) {
    const target = comment.replyTo?.id;
    if (target === undefined) continue;
    repliesOf.set(target, [...(repliesOf.get(target) ?? []), comment]);
  }

  return (
    <View testID="work-comments">
      <Text style={styles.eyebrow}>{t("mobile.work.comments.title")}</Text>

      {comments === undefined ? (
        <Text style={styles.empty} testID="work-comments-unavailable">
          {t("mobile.work.comments.unavailable")}
        </Text>
      ) : comments.length === 0 ? (
        <Text style={styles.empty} testID="work-comments-empty">
          {t("mobile.work.comments.empty")}
        </Text>
      ) : (
        newestFirst(comments).map((comment) => (
          <CommentRow
            key={comment.id}
            comment={comment}
            users={users}
            ticketId={ticketId}
            replying={replyingToId === comment.id}
            replies={repliesOf.get(comment.id) ?? []}
            viewerId={viewerId}
            onJumpToReply={onJumpTo}
            onReply={onReply}
            onCancelReply={onCancelReply}
            onJumpTo={
              // Premibile SOLO se l'originale è qui: altrimenti la riga resta,
              // come testo (originale potato o non più visibile).
              // `?.`: vedi la nota sulla cache persistita in `CommentRow`.
              comment.replyTo?.id !== undefined && present.has(comment.replyTo.id) && onJumpTo !== undefined
                ? onJumpTo
                : undefined
            }
            onLayout={onRowLayout ? (event) => onRowLayout(comment.id, event.nativeEvent.layout.y) : undefined}
          />
        ))
      )}
    </View>
  );
}

/** Dal più recente; a parità di data resta l'ordine del server, rovesciato. */
function newestFirst(comments: Reader<TicketComment>[]): Reader<TicketComment>[] {
  return comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => {
      const diff = Date.parse(b.comment.createdAt) - Date.parse(a.comment.createdAt);
      return diff !== 0 && !Number.isNaN(diff) ? diff : b.index - a.index;
    })
    .map(({ comment }) => comment);
}

function CommentRow({
  comment,
  users,
  ticketId,
  replying,
  replies,
  viewerId,
  onJumpToReply,
  onReply,
  onCancelReply,
  onJumpTo,
  onLayout,
}: {
  comment: Reader<TicketComment>;
  ticketId: string;
  replying: boolean;
  replies: Reader<TicketComment>[];
  viewerId: string | null;
  /** Le card delle risposte portano SEMPRE alla risposta: è in questo elenco. */
  onJumpToReply?: (commentId: string) => void;
  onCancelReply?: () => void;
  users: Reader<PublicUser>[] | undefined;
  onReply?: (comment: Reader<TicketComment>) => void;
  onJumpTo?: (commentId: string) => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const relative = relativeTimeCompact(comment.createdAt);
  const author = comment.authorId !== null ? users?.find((user) => user.id === comment.authorId) : undefined;
  // `?? null` anche se lo schema dice `.default(null)` (5 ott 2026, crash al
  // primo avvio dopo l'aggiornamento): la cache di TanStack persistita su
  // disco (`app/providers.tsx`) rimette in pagina i commenti salvati da una
  // versione PRECEDENTE dell'app SENZA ripassarli dallo schema, quindi un
  // campo nato dopo arriva `undefined`, prima che il refetch lo porti.
  const replyTo = comment.replyTo ?? null;

  return (
    <View style={styles.row} testID={`work-comment-${comment.id}`} onLayout={onLayout}>
      <View style={styles.rowHead}>
        <Text style={styles.author}>{authorLabel(comment, author, t)}</Text>
        <Text style={styles.time}>
          {relative.kind === "now"
            ? t("mobile.work.time.now")
            : t(`mobile.work.time.${relative.kind}`, { count: relative.count })}
        </Text>
      </View>
      {replyTo !== null &&
        (onJumpTo !== undefined ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint={t("mobile.work.comments.jumpToOriginal")}
            onPress={() => onJumpTo(replyTo.id)}
            testID={`work-comment-in-reply-${comment.id}`}
          >
            <Text style={styles.inReplyTo} numberOfLines={2}>
              {inReplyToText(replyTo, t)}
            </Text>
          </Pressable>
        ) : (
          <View testID={`work-comment-in-reply-${comment.id}`}>
            <Text style={styles.inReplyTo} numberOfLines={2}>
              {inReplyToText(replyTo, t)}
            </Text>
          </View>
        ))}
      <SafeMarkdown>{comment.body}</SafeMarkdown>
      {replies.map((reply) => (
        <ReplyCard
          key={reply.id}
          reply={reply}
          users={users}
          viewerId={viewerId}
          onPress={onJumpToReply !== undefined ? () => onJumpToReply(reply.id) : undefined}
        />
      ))}
      {/* «Reply» IN FONDO al commento (5 ott 2026): si risponde dopo aver
          letto, e in cima si perdeva. Premuto, al suo posto si apre il campo. */}
      {replying ? (
        <CommentComposer
          ticketId={ticketId}
          replyingTo={comment}
          replyingToName={authorLabel(comment, author, t)}
          onCancelReply={onCancelReply}
          onSent={onCancelReply}
        />
      ) : (
        onReply !== undefined && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("mobile.work.comments.replyA11y", { name: authorLabel(comment, author, t) })}
            hitSlop={8}
            onPress={() => onReply(comment)}
            style={styles.replyButton}
            testID={`work-comment-reply-${comment.id}`}
          >
            <Text style={styles.replyButtonLabel}>{t("mobile.work.comments.reply")}</Text>
          </Pressable>
        )
      )}
    </View>
  );
}

/** Lunghezza dell'anteprima di una risposta sotto l'originale. */
const REPLY_PREVIEW_CHARS = 120;

/**
 * Una risposta ricevuta, sotto il commento a cui risponde: chi, quando e
 * un'anteprima; premuta porta alla risposta (che sta in cima all'elenco).
 */
function ReplyCard({
  reply,
  users,
  viewerId,
  onPress,
}: {
  reply: Reader<TicketComment>;
  users: Reader<PublicUser>[] | undefined;
  viewerId: string | null;
  onPress?: () => void;
}) {
  const { t } = useTranslation();
  const relative = relativeTimeCompact(reply.createdAt);
  const author = reply.authorId !== null ? users?.find((user) => user.id === reply.authorId) : undefined;
  const who =
    viewerId !== null && reply.authorId === viewerId
      ? t("mobile.work.comments.yourReply")
      : t("mobile.work.comments.replyFrom", { name: authorLabel(reply, author, t) });
  const time =
    relative.kind === "now"
      ? t("mobile.work.time.now")
      : t(`mobile.work.time.${relative.kind}`, { count: relative.count });
  return (
    <Pressable
      accessibilityRole={onPress !== undefined ? "button" : undefined}
      accessibilityHint={onPress !== undefined ? t("mobile.work.comments.goToReply") : undefined}
      disabled={onPress === undefined}
      onPress={onPress}
      style={styles.replyCard}
      testID={`work-comment-reply-card-${reply.id}`}
    >
      <Text style={styles.replyCardHead}>
        ↳ {who} · {time}
      </Text>
      <Text style={styles.replyCardBody} numberOfLines={2}>
        {plainExcerpt(reply.body, REPLY_PREVIEW_CHARS)}
      </Text>
    </Pressable>
  );
}

/**
 * Il nome dell'autore dell'originale, come l'ha derivato il server
 * (`replyTo`): l'email per una persona, altrimenti l'etichetta della sua
 * origine. Un `authorType` ignoto o una persona senza nome (eliminata) è
 * «qualcuno», mai un nome inventato.
 */
function replyAuthorName(replyTo: Reader<CommentReplyTo>, t: (key: string) => string): string {
  if (isUnknown(replyTo.authorType)) return t("mobile.work.comments.authorUnknown");
  if (replyTo.authorType === "ai") return t("mobile.work.comments.authorAi");
  if (replyTo.authorType === "system") return t("mobile.work.comments.authorSystem");
  return replyTo.authorName ?? t("mobile.work.comments.authorUnknown");
}

function inReplyToText(
  replyTo: Reader<CommentReplyTo>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  return t("mobile.work.comments.inReplyTo", { name: replyAuthorName(replyTo, t), excerpt: replyTo.excerpt });
}

/** Il nome dell'autore di un commento dell'elenco: lo usa anche il campo, per la riga «Rispondendo a». */
export function commentAuthorName(
  comment: Reader<TicketComment>,
  users: Reader<PublicUser>[] | undefined,
  t: (key: string) => string,
): string {
  const author = comment.authorId !== null ? users?.find((user) => user.id === comment.authorId) : undefined;
  return authorLabel(comment, author, t);
}

/**
 * Il nome da mostrare. Un `authorType` che questa build non conosce
 * (`readerSchema` lo apre) non finisce a testo grezzo né sparisce: dice che
 * il commento c'è senza pretendere di saperne l'origine — stesso trattamento
 * del `kind` ignoto in `TicketHistory.tsx`.
 */
function authorLabel(
  comment: Reader<TicketComment>,
  author: Reader<PublicUser> | undefined,
  t: (key: string) => string,
): string {
  if (isUnknown(comment.authorType)) return t("mobile.work.comments.authorUnknown");
  if (comment.authorType === "ai") return t("mobile.work.comments.authorAi");
  if (comment.authorType === "system") return t("mobile.work.comments.authorSystem");
  return author?.email ?? t("mobile.work.comments.authorUnknown");
}

const styles = StyleSheet.create({
  eyebrow: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    letterSpacing: 1.4,
    marginBottom: 10,
    textTransform: "uppercase",
  },
  empty: {
    color: colors.faint,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
  },
  row: {
    borderTopColor: colors.line,
    borderTopWidth: 1,
    gap: 4,
    paddingVertical: 10,
  },
  rowHead: {
    alignItems: "baseline",
    flexDirection: "row",
    gap: 8,
  },
  replyButton: {
    alignSelf: "flex-start",
    borderColor: colors.signal,
    borderRadius: radii.control,
    borderWidth: 1,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  replyButtonLabel: {
    color: colors.signal,
    fontFamily: fontFamily.monoSemiBold,
    fontSize: fontSize.label,
  },
  replyCard: {
    backgroundColor: colors.ink900,
    borderLeftColor: colors.signal,
    borderLeftWidth: 2,
    borderRadius: radii.control,
    gap: 2,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  replyCardHead: {
    color: colors.muted,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  replyCardBody: {
    color: colors.fg,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.body,
  },
  inReplyTo: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  replyComposer: {
    marginTop: 8,
  },
  replyCancel: {
    alignSelf: "flex-start",
    marginTop: 6,
  },
  replyCancelLabel: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  author: {
    color: colors.muted,
    flexShrink: 1,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  time: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
  },
  composer: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 8,
  },
  input: {
    backgroundColor: colors.ink900,
    borderColor: colors.lineStrong,
    borderRadius: radii.control,
    borderWidth: 1,
    color: colors.fg,
    flex: 1,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.input,
    maxHeight: 120,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sendButton: {
    alignItems: "center",
    backgroundColor: colors.signal,
    borderRadius: radii.control,
    height: 42,
    justifyContent: "center",
    width: 42,
  },
  sendButtonDisabled: {
    opacity: 0.4,
  },
  sendButtonLabel: {
    color: colors.ink950,
    fontFamily: fontFamily.monoSemiBold,
    fontSize: 18,
  },
  error: {
    color: colors.danger,
    fontFamily: fontFamily.sans,
    fontSize: fontSize.label,
    marginTop: 8,
  },
  offline: {
    color: colors.faint,
    fontFamily: fontFamily.mono,
    fontSize: fontSize.label,
    marginTop: 8,
  },
});
