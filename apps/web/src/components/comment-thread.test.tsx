import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Comment } from "../lib/api";
import { CommentThread } from "./comment-thread";

/**
 * Thread dei commenti: distingue le tre voci (utente, AI, sistema) con badge
 * e firme diverse. I commenti di sistema (es. "PR mergiata, ticket chiuso")
 * non sono né utenti né AI: vanno marcati come tali, non come "Utente rimosso".
 */

const authorEmails = new Map([["u1", "anna@example.com"]]);

function comment(overrides: Partial<Comment>): Comment {
  return {
    id: "c1",
    ticketId: "t1",
    authorType: "user",
    authorId: "u1",
    body: "Testo del commento.",
    createdAt: "2026-06-10T10:00:00.000Z",
    ...overrides,
  };
}

const noop = vi.fn().mockResolvedValue(undefined);

describe("CommentThread", () => {
  it("firma i commenti utente con l'email dell'autore", () => {
    render(
      <CommentThread
        comments={[comment({ authorType: "user", authorId: "u1" })]}
        authorEmails={authorEmails}
        onSubmit={noop}
        pending={false}
      />,
    );
    expect(screen.getByText("anna@example.com")).toBeInTheDocument();
  });

  it("marca i commenti AI con il badge AI", () => {
    render(
      <CommentThread
        comments={[comment({ id: "c2", authorType: "ai", authorId: null })]}
        authorEmails={authorEmails}
        onSubmit={noop}
        pending={false}
      />,
    );
    expect(screen.getByText("AI")).toBeInTheDocument();
    expect(screen.getByText("Stubwise")).toBeInTheDocument();
  });

  it("marca i commenti di sistema con il badge SYSTEM, non 'Removed user'", () => {
    render(
      <CommentThread
        comments={[
          comment({
            id: "c3",
            authorType: "system",
            authorId: null,
            body: "PR mergiata: ticket chiuso automaticamente.",
          }),
        ]}
        authorEmails={authorEmails}
        onSubmit={noop}
        pending={false}
      />,
    );
    expect(screen.getByText("SYSTEM")).toBeInTheDocument();
    expect(screen.queryByText("Removed user")).not.toBeInTheDocument();
    // Niente badge AI: il sistema non è l'AI.
    expect(screen.queryByText("AI")).not.toBeInTheDocument();
    expect(
      screen.getByText("PR mergiata: ticket chiuso automaticamente."),
    ).toBeInTheDocument();
  });
});
