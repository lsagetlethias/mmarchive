import { type ReactNode, useMemo } from "react";
import type { Attachment, Message, Reaction } from "../client/archive-client.js";
import { formatSize, formatTime, useArchive, useAssetUrl, useAuthor } from "../data.js";
import { standardEmoji } from "./emoji.js";
import { renderMarkdown } from "./markdown.js";

const SKIP_REASONS: Readonly<Record<string, string>> = {
  skipped_by_option: "non telechargee a l extraction",
  too_large: "trop volumineuse pour l archive",
  forbidden: "telechargement refuse par le serveur",
  download_failed: "telechargement echoue",
};

function Avatar({ userId }: { readonly userId: number | null }): ReactNode {
  const { name, user } = useAuthor(userId);
  const url = useAssetUrl("avatar", user?.avatar == null ? null : user.uid);
  if (url === undefined) {
    return <div className="avatar avatar-vide">{name.slice(0, 1).toUpperCase()}</div>;
  }
  return <img className="avatar" src={url} alt="" loading="lazy" />;
}

function Reactions({ reactions }: { readonly reactions: readonly Reaction[] }): ReactNode {
  const { client } = useArchive();
  const grouped = useMemo(() => {
    const counts = new Map<string, number>();
    for (const reaction of reactions) {
      counts.set(reaction.emoji, (counts.get(reaction.emoji) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [reactions]);

  if (grouped.length === 0) return null;
  return (
    <div className="reactions">
      {grouped.map(([emoji, count]) => {
        const standard = standardEmoji(emoji);
        return (
          <span className="reaction" key={emoji} title={`:${emoji}:`}>
            {standard === undefined ? (
              <img
                className="emoji"
                src={client.emojiUrl(emoji)}
                alt={`:${emoji}:`}
                loading="lazy"
              />
            ) : (
              <span className="emoji">{standard}</span>
            )}
            <span className="reaction-compte">{count}</span>
          </span>
        );
      })}
    </div>
  );
}

function Attachments({ files }: { readonly files: readonly Attachment[] }): ReactNode {
  const { client } = useArchive();
  if (files.length === 0) return null;
  return (
    <div className="pieces-jointes">
      {files.map((file) => {
        if (file.path === null) {
          const reason = SKIP_REASONS[file.skipReason ?? ""] ?? "absente de l archive";
          // La metadonnee existe sans le contenu : l afficher vaut mieux que de
          // faire disparaitre une piece jointe qui a existe.
          return (
            <div className="piece-jointe absente" key={file.fid}>
              <span className="piece-jointe-nom">{file.name}</span>
              <span className="piece-jointe-detail">
                {formatSize(file.size)}, {reason}
              </span>
            </div>
          );
        }
        const href = client.fileUrl(file.fid);
        if (href === "") {
          // Mode sans serveur : les 26 Go de pieces jointes ne voyagent pas dans
          // l index. La metadonnee reste, pour ne pas faire disparaitre ce qui a
          // existe.
          return (
            <div className="piece-jointe absente" key={file.fid}>
              <span className="piece-jointe-nom">{file.name}</span>
              <span className="piece-jointe-detail">
                {formatSize(file.size)}, absente de cette copie
              </span>
            </div>
          );
        }
        const isImage = file.mime.startsWith("image/");
        return (
          <a
            className={isImage ? "piece-jointe image" : "piece-jointe"}
            key={file.fid}
            href={href}
            download={file.name}
          >
            {isImage ? (
              // Les dimensions viennent de l archive : les poser reserve la
              // place avant le chargement. Sans elles, la rangee est mesuree
              // trop courte puis grandit, et la lecture saute.
              <img
                src={href}
                alt={file.name}
                loading="lazy"
                {...(file.width > 0 && file.height > 0
                  ? { width: file.width, height: file.height }
                  : {})}
              />
            ) : null}
            <span className="piece-jointe-nom">{file.name}</span>
            <span className="piece-jointe-detail">{formatSize(file.size)}</span>
          </a>
        );
      })}
    </div>
  );
}

export interface MessageRowProps {
  readonly message: Message;
  readonly reactions: readonly Reaction[];
  readonly attachments: readonly Attachment[];
  /** Groupe avec le message precedent : meme auteur, a quelques minutes. */
  readonly grouped: boolean;
  readonly replyCount?: number;
  readonly highlighted?: boolean;
  onOpenThread?(message: Message): void;
}

export function MessageRow({
  message,
  reactions,
  attachments,
  grouped,
  replyCount,
  highlighted,
  onOpenThread,
}: MessageRowProps): ReactNode {
  const { render } = useArchive();
  const { name } = useAuthor(message.userId);
  const html = useMemo(
    () => (message.message === "" ? "" : renderMarkdown(message.message, render)),
    [message.message, render],
  );

  return (
    <article
      className={`message${grouped ? " groupe" : ""}${highlighted === true ? " cible" : ""}`}
      id={`message-${String(message.id)}`}
    >
      <div className="message-gouttiere">
        {grouped ? (
          <span className="heure-survol">{formatTime(message.createAt)}</span>
        ) : (
          <Avatar userId={message.userId} />
        )}
      </div>
      <div className="message-corps">
        {grouped ? null : (
          <header className="message-entete">
            <span className="auteur">{name}</span>
            <time dateTime={new Date(message.createAt).toISOString()}>
              {formatTime(message.createAt)}
            </time>
            {message.edited ? <span className="etiquette">modifie</span> : null}
            {message.pinned ? <span className="etiquette">epingle</span> : null}
          </header>
        )}
        {message.orphanRoot ? (
          // 17 871 messages de cette archive sont dans ce cas : leur racine n a
          // pas ete extraite. Le dire evite de lire une reponse comme un propos
          // isole.
          <p className="avertissement">Reponse a un message absent de l archive</p>
        ) : null}
        {html === "" ? null : (
          // Le balisage ecrit par les auteurs est echappe par markdown-it, puis
          // le rendu passe par une liste blanche d elements. Voir markdown.ts.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: contenu echappe puis assaini, seule voie pour rendre du Markdown
          <div className="contenu" dangerouslySetInnerHTML={{ __html: html }} />
        )}
        <Attachments files={attachments} />
        <Reactions reactions={reactions} />
        {replyCount !== undefined && replyCount > 0 ? (
          <button
            type="button"
            className="lien-fil"
            onClick={() => {
              onOpenThread?.(message);
            }}
          >
            {replyCount === 1 ? "1 reponse" : `${String(replyCount)} reponses`}
          </button>
        ) : null}
      </div>
    </article>
  );
}
