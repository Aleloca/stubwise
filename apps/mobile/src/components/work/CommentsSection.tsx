import type { PublicUser, Reader, TicketComment } from "@stubwise/shared";
import { isUnknown } from "@stubwise/shared";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
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
 */
export function CommentComposer({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation();
  const add = useAddComment(ticketId);
  const [draft, setDraft] = useState("");

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= COMMENT_MAX_CHARS && !add.disabled;

  function send(): void {
    if (!canSend) return;
    add.mutate(trimmed);
    setDraft("");
  }

  return (
    <View testID="work-comment-composer">
      <View style={styles.composer}>
        <TextInput
          accessibilityLabel={t("mobile.work.comments.placeholder")}
          value={draft}
          onChangeText={setDraft}
          editable={!add.disabled}
          multiline
          placeholder={t("mobile.work.comments.placeholder")}
          placeholderTextColor={colors.faint}
          style={styles.input}
          testID="work-comment-input"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("mobile.work.comments.send")}
          accessibilityState={{ disabled: !canSend }}
          disabled={!canSend}
          onPress={send}
          style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
          testID="work-comment-send"
        >
          <Text style={styles.sendButtonLabel}>↑</Text>
        </Pressable>
      </View>

      {add.errorMessage !== null && (
        <Text accessibilityLiveRegion="polite" style={styles.error} testID="work-comment-error">
          {add.errorMessage}
        </Text>
      )}
      {!add.online && (
        <Text style={styles.offline} testID="work-comment-offline">
          {t("mobile.work.comments.offline")}
        </Text>
      )}
    </View>
  );
}

export function CommentList({
  comments,
  users,
}: {
  /** `undefined` finché la query non ha risposto, o se è fallita. */
  comments: Reader<TicketComment>[] | undefined;
  /** Per dare un nome all'autore di un commento; `undefined` se l'elenco non è arrivato. */
  users: Reader<PublicUser>[] | undefined;
}) {
  const { t } = useTranslation();

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
          <CommentRow key={comment.id} comment={comment} users={users} />
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
}: {
  comment: Reader<TicketComment>;
  users: Reader<PublicUser>[] | undefined;
}) {
  const { t } = useTranslation();
  const relative = relativeTimeCompact(comment.createdAt);
  const author = comment.authorId !== null ? users?.find((user) => user.id === comment.authorId) : undefined;

  return (
    <View style={styles.row} testID={`work-comment-${comment.id}`}>
      <View style={styles.rowHead}>
        <Text style={styles.author}>{authorLabel(comment, author, t)}</Text>
        <Text style={styles.time}>
          {relative.kind === "now"
            ? t("mobile.work.time.now")
            : t(`mobile.work.time.${relative.kind}`, { count: relative.count })}
        </Text>
      </View>
      <SafeMarkdown>{comment.body}</SafeMarkdown>
    </View>
  );
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
