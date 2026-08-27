import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import type { Message, MessageBundle } from "./client/archive-client.js";
import { formatDate, useArchive } from "./data.js";
import { channelHref, navigate, type Route, searchHref, useRoute } from "./route.js";
import { MessageList } from "./ui/MessageList.js";
import { SearchView } from "./ui/SearchView.js";
import { ThreadPanel } from "./ui/ThreadPanel.js";

function ChannelSidebar({ current }: { readonly current: number | undefined }): ReactNode {
  const { channels } = useArchive();
  const [filter, setFilter] = useState("");

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === "") return channels;
    return channels.filter(
      (channel) =>
        channel.name.toLowerCase().includes(needle) ||
        channel.displayName.toLowerCase().includes(needle),
    );
  }, [channels, filter]);

  return (
    <nav className="barre-canaux">
      <input
        type="search"
        className="filtre-canaux"
        placeholder={`Filtrer ${String(channels.length)} canaux`}
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />
      <ul>
        {shown.map((channel) => (
          <li key={channel.id}>
            <a
              className={channel.id === current ? "canal actif" : "canal"}
              href={channelHref(channel.id)}
              title={channel.purpose === "" ? channel.displayName : channel.purpose}
            >
              <span className="canal-nom">{channel.displayName}</span>
              <span className="canal-compte">{channel.posts.toLocaleString("fr-FR")}</span>
            </a>
          </li>
        ))}
        {shown.length === 0 ? <li className="vide">Aucun canal</li> : null}
      </ul>
    </nav>
  );
}

function ChannelView({
  channelId,
  focusId,
  onOpenThread,
}: {
  readonly channelId: number;
  readonly focusId: number | undefined;
  onOpenThread(message: Message): void;
}): ReactNode {
  const { client, channelById } = useArchive();
  const [initial, setInitial] = useState<MessageBundle | undefined>();
  const [error, setError] = useState<string | undefined>();
  const channel = channelById.get(channelId);

  useEffect(() => {
    let cancelled = false;
    setInitial(undefined);
    setError(undefined);
    // Un permalien ouvre le message dans son contexte, pas la fin du canal.
    const load =
      focusId === undefined
        ? client.channelMessages(channelId, { limit: 50 })
        : client.messageContext(focusId);
    load
      .then((bundle) => {
        if (!cancelled) setInitial(bundle);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "lecture impossible");
      });
    return () => {
      cancelled = true;
    };
  }, [client, channelId, focusId]);

  if (channel === undefined)
    return <p className="erreur">Ce canal ne figure pas dans l archive.</p>;

  return (
    <section className="vue-canal">
      <header className="vue-entete">
        <h1>{channel.displayName}</h1>
        <p className="vue-detail">
          {channel.posts.toLocaleString("fr-FR")} messages
          {channel.firstAt === null
            ? null
            : `, du ${formatDate(channel.firstAt)} au ${formatDate(channel.lastAt ?? channel.firstAt)}`}
          {channel.archived ? ", canal archive" : ""}
        </p>
        {channel.purpose === "" ? null : <p className="vue-objet">{channel.purpose}</p>}
      </header>
      {error !== undefined ? <p className="erreur">{error}</p> : null}
      {initial === undefined ? (
        <p className="chargement">Chargement</p>
      ) : (
        <MessageList
          sourceKey={`${String(channelId)}-${String(focusId ?? 0)}`}
          initial={initial}
          loadOlder={(before) => client.channelMessages(channelId, { limit: 50, before })}
          onOpenThread={onOpenThread}
          focusId={focusId}
        />
      )}
    </section>
  );
}

function DirectoryView(): ReactNode {
  const { userById, client } = useArchive();
  const [filter, setFilter] = useState("");
  const users = useMemo(() => [...userById.values()], [userById]);
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching =
      needle === ""
        ? users
        : users.filter(
            (user) =>
              user.username.toLowerCase().includes(needle) ||
              user.display.toLowerCase().includes(needle) ||
              user.position.toLowerCase().includes(needle),
          );
    return matching.slice(0, 500);
  }, [users, filter]);

  return (
    <section className="vue-annuaire">
      <header className="vue-entete">
        <h1>Annuaire</h1>
        <p className="vue-detail">{users.length.toLocaleString("fr-FR")} comptes</p>
      </header>
      <input
        type="search"
        className="filtre-canaux"
        placeholder="Filtrer par nom ou fonction"
        value={filter}
        onChange={(event) => {
          setFilter(event.target.value);
        }}
      />
      <ul className="annuaire">
        {shown.map((user) => (
          <li key={user.id} className={user.deactivated ? "desactive" : ""}>
            {user.avatar === null ? (
              <div className="avatar avatar-vide">{user.display.slice(0, 1).toUpperCase()}</div>
            ) : (
              <img className="avatar" src={client.avatarUrl(user.uid)} alt="" loading="lazy" />
            )}
            <div>
              <a href={searchHref(`from:${user.username}`)}>{user.display}</a>
              <span className="annuaire-detail">
                @{user.username}
                {user.position === "" ? "" : `, ${user.position}`}
                {user.isBot ? ", robot" : ""}
                {user.deactivated ? ", compte desactive" : ""}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {users.length > shown.length ? (
        <p className="vide">Affinez le filtre pour voir les autres comptes.</p>
      ) : null}
    </section>
  );
}

function HomeView(): ReactNode {
  const { meta, channels } = useArchive();
  const recents = channels.slice(0, 12);
  return (
    <section className="vue-accueil">
      <h1>Archive</h1>
      <p className="vue-detail">
        {meta.counts.posts.toLocaleString("fr-FR")} messages dans{" "}
        {meta.counts.channels.toLocaleString("fr-FR")} canaux,{" "}
        {meta.counts.users.toLocaleString("fr-FR")} comptes.
      </p>
      <h2>Canaux actifs recemment</h2>
      <ul className="grille-canaux">
        {recents.map((channel) => (
          <li key={channel.id}>
            <a href={channelHref(channel.id)}>
              <span className="canal-nom">{channel.displayName}</span>
              <span className="annuaire-detail">
                {channel.posts.toLocaleString("fr-FR")} messages
                {channel.lastAt === null ? "" : `, jusqu au ${formatDate(channel.lastAt)}`}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Resout un identifiant Mattermost puis redirige vers le message dans son canal. */
function PermalinkView({ pid }: { readonly pid: string }): ReactNode {
  const { client } = useArchive();
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .permalink(pid)
      .then((message) => {
        if (cancelled) return;
        if (message === null) setMissing(true);
        else navigate(channelHref(message.channelId, message.id).slice(1));
      })
      .catch(() => {
        if (!cancelled) setMissing(true);
      });
    return () => {
      cancelled = true;
    };
  }, [client, pid]);

  return missing ? (
    <p className="erreur">
      Ce message ne figure pas dans l archive. Il peut appartenir a un canal non extrait, ou avoir
      ete supprime avant l extraction.
    </p>
  ) : (
    <p className="chargement">Resolution du lien</p>
  );
}

function currentChannel(route: Route): number | undefined {
  return route.view === "canal" ? route.channelId : undefined;
}

export function App(): ReactNode {
  const route = useRoute();
  const [thread, setThread] = useState<Message | undefined>();
  const [draft, setDraft] = useState(route.view === "recherche" ? route.query : "");

  // Changer de vue ferme le fil ouvert : il appartient au canal qu on quitte.
  // La dependance est volontaire, l effet ne lit rien mais doit rejouer a chaque
  // changement de route.
  // biome-ignore lint/correctness/useExhaustiveDependencies: la route est le declencheur, pas une valeur lue
  useEffect(() => {
    setThread(undefined);
  }, [route.view]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    navigate(searchHref(draft).slice(1));
  };

  return (
    <div className="application">
      <header className="barre-haut">
        <a className="marque" href="#/">
          Archive
        </a>
        <search className="recherche">
          <form onSubmit={submit}>
            <input
              type="search"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
              placeholder="Rechercher, par exemple from:alice in:general"
              aria-label="Rechercher dans l archive"
            />
            <button type="submit">Chercher</button>
          </form>
        </search>
        <a className="lien-annuaire" href="#/annuaire">
          Annuaire
        </a>
      </header>

      <div className="corps">
        <ChannelSidebar current={currentChannel(route)} />
        <main className={thread === undefined ? "" : "avec-fil"}>
          {route.view === "accueil" ? <HomeView /> : null}
          {route.view === "canal" ? (
            <ChannelView
              channelId={route.channelId}
              focusId={route.focusId}
              onOpenThread={setThread}
            />
          ) : null}
          {route.view === "recherche" ? <SearchView query={route.query} /> : null}
          {route.view === "annuaire" ? <DirectoryView /> : null}
          {route.view === "permalien" ? <PermalinkView pid={route.pid} /> : null}
        </main>
        {thread === undefined ? null : (
          <ThreadPanel
            root={thread}
            onClose={() => {
              setThread(undefined);
            }}
          />
        )}
      </div>
    </div>
  );
}
