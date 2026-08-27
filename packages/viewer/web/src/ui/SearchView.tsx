import { type ReactNode, useEffect, useState } from "react";
import type { Message, SearchOutcome } from "../client/archive-client.js";
import { formatDate, formatTime, useArchive } from "../data.js";
import { channelHref } from "../route.js";

const AIDE = [
  ["from:nom", "messages d une personne"],
  ["in:canal", "messages d un canal"],
  ['"phrase exacte"', "les mots dans cet ordre"],
  ["-mot", "exclut un mot"],
  ["mot*", "commence par"],
  ["#etiquette", "une etiquette"],
  ["on: avant: apres:", "au format aaaa-mm-jj"],
];

function Resultat({ message }: { readonly message: Message }): ReactNode {
  const { channelById, userById } = useArchive();
  const channel = channelById.get(message.channelId);
  const author = message.userId === null ? undefined : userById.get(message.userId);
  return (
    <a className="resultat" href={channelHref(message.channelId, message.id)}>
      <div className="resultat-entete">
        <span className="resultat-canal">{channel?.displayName ?? "Canal inconnu"}</span>
        <span className="resultat-auteur">{author?.display ?? "Compte inconnu"}</span>
        <time>
          {formatDate(message.createAt)} a {formatTime(message.createAt)}
        </time>
      </div>
      <p className="resultat-extrait">{message.message.slice(0, 320)}</p>
    </a>
  );
}

/**
 * Decalage du lecteur, dans le sens attendu par la recherche : positif a l est
 * de Greenwich. getTimezoneOffset rend l inverse, et le confondre decalerait
 * toutes les bornes de dates d autant.
 */
function readerOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

export function SearchView({ query }: { readonly query: string }): ReactNode {
  const { client } = useArchive();
  const [outcome, setOutcome] = useState<SearchOutcome | undefined>();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | undefined>();

  useEffect(() => {
    if (query.trim() === "") {
      setOutcome(undefined);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setErreur(undefined);
    client
      .search(query, { limit: 50, timeZoneOffsetMinutes: readerOffsetMinutes() })
      .then((result) => {
        if (!cancelled) setOutcome(result);
      })
      .catch((cause: unknown) => {
        // Sans branche d erreur, l attente disparait et l ecran reste vide,
        // ce qui se lit comme une recherche sans resultat.
        if (!cancelled) setErreur(cause instanceof Error ? cause.message : "recherche impossible");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, query]);

  return (
    <section className="vue-recherche">
      <header className="vue-entete">
        <h1>Recherche</h1>
        {query.trim() === "" ? null : <p className="requete">{query}</p>}
      </header>

      {query.trim() === "" ? (
        <div className="aide">
          <p>Modificateurs disponibles :</p>
          <dl>
            {AIDE.map(([syntax, meaning]) => (
              <div key={syntax}>
                <dt>{syntax}</dt>
                <dd>{meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {busy ? <p className="chargement">Recherche</p> : null}
      {erreur === undefined ? null : <p className="erreur">{erreur}</p>}

      {outcome?.status === "introuvable" ? (
        // Un filtre qui ne designe personne ne doit pas etre ignore en silence :
        // la recherche serait alors plus large que demandee.
        <p className="erreur">
          {outcome.names.length === 1 ? "Introuvable" : "Introuvables"} : {outcome.names.join(", ")}
          . Verifiez le nom du canal ou de la personne.
        </p>
      ) : null}
      {outcome?.status === "sans-terme-positif" ? (
        <p className="erreur">
          Ajoutez au moins un mot a chercher, une exclusion seule ne suffit pas.
        </p>
      ) : null}
      {outcome?.status === "vide" ? (
        <p className="erreur">Rien a chercher dans cette saisie.</p>
      ) : null}

      {outcome?.status === "ok" ? (
        outcome.messages.length === 0 ? (
          <p className="vide">Aucun message ne correspond.</p>
        ) : (
          <div className="resultats">
            {outcome.messages.map((message) => (
              <Resultat key={message.id} message={message} />
            ))}
            {outcome.nextCursor === null ? null : (
              <p className="vide">Seuls les cinquante resultats les plus recents sont affiches.</p>
            )}
          </div>
        )
      ) : null}
    </section>
  );
}
