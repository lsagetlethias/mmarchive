import { type ReactNode, useEffect, useState } from "react";
import { formatSize } from "../data.js";

interface LiteInfo {
  readonly disponible: boolean;
  readonly manquant: readonly string[];
  readonly octets: number;
  readonly fichiers: number;
}

/**
 * Emporter l archive.
 *
 * Le mode complet sait engendrer le mode allege : c est la contrainte du
 * cadrage, et elle tient parce que l index est le meme fichier dans les deux
 * cas. Cette vue n existe que servie par un serveur ; une copie deja autonome
 * n a personne a qui demander la suivante.
 */
export function TakeAwayView(): ReactNode {
  const [info, setInfo] = useState<LiteInfo | undefined>();
  const [erreur, setErreur] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    fetch("api/lite")
      .then(async (response) => {
        // Un statut d erreur porte rarement du JSON : tenter de l analyser
        // ferait passer une panne du serveur pour une copie deja autonome.
        if (!response.ok) throw new Error(`Le serveur a repondu ${String(response.status)}.`);
        return (await response.json()) as LiteInfo;
      })
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setErreur(
            cause instanceof TypeError
              ? "Cette copie est deja autonome : elle ne peut pas en produire une autre."
              : `Copie indisponible. ${cause instanceof Error ? cause.message : ""}`.trim(),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="vue-emporter">
      <header className="vue-entete">
        <h1>Emporter cette archive</h1>
        <p className="vue-detail">
          Une copie qui se consulte sans serveur, sur un poste ou dans un dossier partage.
        </p>
      </header>

      <div className="emporter-corps">
        {erreur === undefined ? null : <p className="erreur">{erreur}</p>}
        {info === undefined && erreur === undefined ? (
          <p className="chargement">Verification</p>
        ) : null}

        {info?.disponible === true ? (
          <>
            <p>
              La copie contient {info.fichiers.toLocaleString("fr-FR")} fichiers, soit{" "}
              {formatSize(info.octets)} avant compression. Elle est assemblee au fil de l envoi,
              comptez quelques minutes.
            </p>
            <p>
              <a className="bouton-telecharger" href="lite.zip" download>
                Telecharger la copie
              </a>
            </p>
          </>
        ) : null}

        {info !== undefined && !info.disponible ? (
          <p className="erreur">
            Copie indisponible, il manque : {info.manquant.join(", ")}. Construisez le viewer avec{" "}
            <code>pnpm --filter @mmarchive/viewer build</code>.
          </p>
        ) : null}

        <h2>Ce que la copie contient</h2>
        <p>
          Les messages, les canaux, les comptes, les reactions, les avatars et les emojis
          personnalises. La recherche fonctionne hors ligne, sur la totalite des messages.
        </p>

        <h2>Ce qu elle ne contient pas</h2>
        <p>
          Le contenu des pieces jointes. Leur nom, leur taille et leur type restent affiches, mais
          les fichiers eux memes pesent plusieurs dizaines de gigaoctets et demeurent dans l archive
          d origine.
        </p>

        <h2>Comment s en servir</h2>
        <p>
          Ouvrez <code>archive.html</code> par double clic, puis designez <code>index.db</code>{" "}
          quand la page le demande. Rien n est televerse : le fichier est lu sur place, par
          tranches.
        </p>
        <p>
          Pour la mettre a disposition de plusieurs personnes, servez le dossier <code>web/</code>{" "}
          avec <code>index.db</code> a cote, depuis n importe quel serveur de fichiers. Celui ci
          doit repondre aux requetes par plage et ne pas recompresser les reponses, sans quoi les
          plages demandees ne correspondraient plus au fichier.
        </p>
      </div>
    </section>
  );
}
