import { type ReactNode, useEffect, useState } from "react";
import type { Attachment, Message, MessageBundle, Reaction } from "../client/archive-client.js";
import { formatDate, useArchive } from "../data.js";
import { MessageRow } from "./Message.js";

export function ThreadPanel({
  root,
  onClose,
}: {
  readonly root: Message;
  onClose(): void;
}): ReactNode {
  const { client } = useArchive();
  const [bundle, setBundle] = useState<MessageBundle | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setBundle(undefined);
    setError(undefined);
    // Un fil se lit par sa racine : une reponse ouvre le fil de sa racine, pas
    // le sien, qui n existe pas.
    client
      .thread(root.rootId ?? root.id)
      .then((loaded) => {
        if (!cancelled) setBundle(loaded);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "fil illisible");
      });
    return () => {
      cancelled = true;
    };
  }, [client, root]);

  const reactionsOf = (id: number): Reaction[] =>
    (bundle?.reactions ?? []).filter((reaction) => reaction.messageId === id);
  const attachmentsOf = (id: number): Attachment[] =>
    (bundle?.attachments ?? []).filter((attachment) => attachment.messageId === id);

  return (
    <aside className="panneau-fil">
      <header className="panneau-entete">
        <h2>Fil de discussion</h2>
        <button type="button" onClick={onClose} aria-label="Fermer le fil">
          Fermer
        </button>
      </header>
      <div className="panneau-corps">
        {error !== undefined ? <p className="erreur">{error}</p> : null}
        {bundle === undefined && error === undefined ? (
          <p className="chargement">Chargement</p>
        ) : null}
        {bundle?.messages.map((message, index) => (
          <div key={message.id}>
            {index === 0 ? (
              <p className="separateur-jour">
                <span>{formatDate(message.createAt)}</span>
              </p>
            ) : null}
            <MessageRow
              message={message}
              reactions={reactionsOf(message.id)}
              attachments={attachmentsOf(message.id)}
              grouped={false}
              highlighted={message.id === root.id}
            />
          </div>
        ))}
      </div>
    </aside>
  );
}
