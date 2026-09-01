import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Attachment, Message, MessageBundle, Reaction } from "../client/archive-client.js";
import { formatDate, formatDay } from "../data.js";
import { MessageRow } from "./Message.js";

/** Cas vide partage : `?? []` recreerait un tableau a chaque rendu. */
const AUCUNE_REACTION: readonly Reaction[] = [];
const AUCUNE_PIECE_JOINTE: readonly Attachment[] = [];

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
  const [failed, setFailed] = useState(false);
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
  //
  // Memoise parce que le virtualiseur rend a chaque frame de defilement, et que
  // le tampon ne redescend jamais dans une session : mesure sur ce meme travail,
  // 11 ms par rendu a 40 000 messages charges, soit les deux tiers du budget
  // d une frame a 60 fps, contre 0,24 ms a 1 000.
  const messages = useMemo(
    () => [...bundle.messages].sort((a, b) => a.id - b.id),
    [bundle.messages],
  );
  const rows = useMemo(() => buildRows(messages), [messages]);

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
    setFailed(false);
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
      .catch(() => {
        // Sans cela, l echec passe en rejet non gere et l indication revient a
        // "Remontez pour lire la suite", comme si rien ne s etait produit.
        setFailed(true);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [bundle.nextCursor, loading, loadOlder, messages]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element !== null && element.scrollTop < LOAD_THRESHOLD_PX) loadMore();
  }, [loadMore]);

  const reactionsByMessage = useMemo(() => {
    const index = new Map<number, Reaction[]>();
    for (const reaction of bundle.reactions) {
      const list = index.get(reaction.messageId);
      if (list === undefined) index.set(reaction.messageId, [reaction]);
      else list.push(reaction);
    }
    return index;
  }, [bundle.reactions]);
  const attachmentsByMessage = useMemo(() => {
    const index = new Map<number, Attachment[]>();
    for (const attachment of bundle.attachments) {
      const list = index.get(attachment.messageId);
      if (list === undefined) index.set(attachment.messageId, [attachment]);
      else list.push(attachment);
    }
    return index;
  }, [bundle.attachments]);

  return (
    <div className="liste-messages" ref={scrollRef} onScroll={onScroll} key={sourceKey}>
      {bundle.nextCursor === null ? (
        <p className="debut-canal">Debut de ce qui a ete archive</p>
      ) : failed ? (
        <p className="erreur">
          Les messages plus anciens n ont pas pu etre lus. Reessayez en remontant.
        </p>
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
                  reactions={reactionsByMessage.get(row.message.id) ?? AUCUNE_REACTION}
                  attachments={attachmentsByMessage.get(row.message.id) ?? AUCUNE_PIECE_JOINTE}
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
