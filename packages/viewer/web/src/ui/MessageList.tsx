import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Attachment, Message, MessageBundle, Reaction } from "../client/archive-client.js";
import { formatDate, formatDay } from "../data.js";
import { MessageRow } from "./Message.js";

/** Deux messages du meme auteur a moins de cinq minutes forment un bloc. */
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

/** Hauteur supposee avant mesure. Sous estimer fait sauter le defilement. */
const ESTIMATED_ROW_HEIGHT = 68;

/** Distance au bord haut a partir de laquelle la page suivante est demandee. */
const LOAD_THRESHOLD_PX = 600;

interface Row {
  readonly kind: "message" | "separateur";
  readonly key: string;
  readonly message?: Message;
  readonly grouped?: boolean;
  readonly label?: string;
}

function buildRows(messages: readonly Message[]): Row[] {
  const rows: Row[] = [];
  let previous: Message | undefined;
  let previousDay = "";

  for (const message of messages) {
    const day = formatDay(message.createAt);
    if (day !== previousDay) {
      rows.push({ kind: "separateur", key: `jour-${day}`, label: formatDate(message.createAt) });
      previousDay = day;
      previous = undefined;
    }
    const grouped =
      previous !== undefined &&
      previous.userId === message.userId &&
      message.createAt - previous.createAt < GROUPING_WINDOW_MS &&
      !message.orphanRoot;
    rows.push({ kind: "message", key: `m-${String(message.id)}`, message, grouped });
    previous = message;
  }
  return rows;
}

export interface MessageListProps {
  /** Change d identite quand la source change : la liste se reinitialise alors. */
  readonly sourceKey: string;
  readonly initial: MessageBundle;
  loadOlder(before: number): Promise<MessageBundle>;
  onOpenThread(message: Message): void;
  readonly focusId?: number | undefined;
}

export function MessageList({
  sourceKey,
  initial,
  loadOlder,
  onOpenThread,
  focusId,
}: MessageListProps): ReactNode {
  const [bundle, setBundle] = useState<MessageBundle>(initial);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingAnchor = useRef<number | null>(null);
  const initialised = useRef(false);

  useEffect(() => {
    setBundle(initial);
    initialised.current = false;
  }, [initial]);

  // L API rend les messages du plus recent au plus ancien, parce que c est dans
  // ce sens qu une page se decoupe. La lecture, elle, se fait dans l ordre ou
  // la conversation s est deroulee.
  const messages = [...bundle.messages].sort((a, b) => a.id - b.id);
  const rows = buildRows(messages);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.key ?? String(index),
    overscan: 12,
  });

  // Position de depart : le bas pour un canal, le message vise pour un
  // permalien. Sans cela on ouvrirait une conversation par son plus ancien
  // message, ce qui n a de sens ni pour lire ni pour reprendre.
  useLayoutEffect(() => {
    if (initialised.current || rows.length === 0) return;
    initialised.current = true;
    if (focusId === undefined) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" });
      return;
    }
    const index = rows.findIndex((row) => row.message?.id === focusId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [rows, focusId, virtualizer]);

  // Ajouter des messages en tete deplace vers le bas tout ce qui etait affiche.
  // On rappelle donc a l ecran le message qui etait en tete avant l ajout, par
  // son index, plutot que de corriger scrollTop : a hauteurs mesurees, la
  // hauteur totale n est pas encore stabilisee quand l effet s execute.
  //
  // Sans cette compensation la lecture reste collee en haut, ce qui redeclenche
  // aussitot un chargement et fait defiler le canal entier tout seul.
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    if (anchor === null) return;
    const index = rows.findIndex((row) => row.message?.id === anchor);
    if (index < 0) return;
    pendingAnchor.current = null;
    virtualizer.scrollToIndex(index, { align: "start" });
  }, [rows, virtualizer]);

  const loadMore = useCallback(() => {
    const cursor = bundle.nextCursor;
    if (cursor === null || loading) return;
    setLoading(true);
    loadOlder(cursor)
      .then((older) => {
        pendingAnchor.current = messages[0]?.id ?? null;
        setBundle((current) => ({
          messages: [...older.messages, ...current.messages],
          reactions: [...older.reactions, ...current.reactions],
          attachments: [...older.attachments, ...current.attachments],
          replyCounts: { ...current.replyCounts, ...older.replyCounts },
          nextCursor: older.nextCursor,
        }));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [bundle.nextCursor, loading, loadOlder, messages]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element !== null && element.scrollTop < LOAD_THRESHOLD_PX) loadMore();
  }, [loadMore]);

  const reactionsByMessage = new Map<number, Reaction[]>();
  for (const reaction of bundle.reactions) {
    const list = reactionsByMessage.get(reaction.messageId);
    if (list === undefined) reactionsByMessage.set(reaction.messageId, [reaction]);
    else list.push(reaction);
  }
  const attachmentsByMessage = new Map<number, Attachment[]>();
  for (const attachment of bundle.attachments) {
    const list = attachmentsByMessage.get(attachment.messageId);
    if (list === undefined) attachmentsByMessage.set(attachment.messageId, [attachment]);
    else list.push(attachment);
  }

  return (
    <div className="liste-messages" ref={scrollRef} onScroll={onScroll} key={sourceKey}>
      {bundle.nextCursor === null ? (
        <p className="debut-canal">Debut de ce qui a ete archive</p>
      ) : (
        <p className="chargement">{loading ? "Chargement" : "Remontez pour lire la suite"}</p>
      )}
      <div
        className="fenetre-virtuelle"
        style={{ height: `${String(virtualizer.getTotalSize())}px` }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (row === undefined) return null;
          return (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="rangee"
              style={{ transform: `translateY(${String(item.start)}px)` }}
            >
              {row.kind === "separateur" ? (
                <div className="separateur-jour">
                  <span>{row.label}</span>
                </div>
              ) : row.message === undefined ? null : (
                <MessageRow
                  message={row.message}
                  reactions={reactionsByMessage.get(row.message.id) ?? []}
                  attachments={attachmentsByMessage.get(row.message.id) ?? []}
                  grouped={row.grouped ?? false}
                  replyCount={bundle.replyCounts[String(row.message.id)] ?? 0}
                  highlighted={focusId === row.message.id}
                  onOpenThread={onOpenThread}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
