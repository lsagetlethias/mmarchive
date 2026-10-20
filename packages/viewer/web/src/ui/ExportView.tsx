import { type ReactNode, useEffect, useState } from "react";
import { formatSize } from "../data.js";

interface LiteInfo {
  readonly disponible: boolean;
  readonly manquant: readonly string[];
  readonly octets: number;
  readonly fichiers: number;
}

/**
 * Le mode complet sait engendrer le mode allege : c est la contrainte du
 * cadrage, et elle tient parce que l index est le meme fichier dans les deux
 * cas.
 */
export function ExportView(): ReactNode {
  const [info, setInfo] = useState<LiteInfo | undefined>();
  const [erreur, setErreur] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    fetch("api/lite")
      .then(async (response) => {
        // Un statut d erreur porte rarement du JSON : tenter de l analyser
        // masquerait la vraie panne derriere une erreur de syntaxe.
        if (!response.ok) throw new Error(`Le serveur a repondu ${String(response.status)}.`);
        return (await response.json()) as LiteInfo;
      })
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setErreur(`Export indisponible. ${cause instanceof Error ? cause.message : ""}`.trim());
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="vue-exporter">
      <header className="vue-entete">
        <h1>Exporter l archive</h1>
        <p className="vue-detail">Une copie a garder sur ton poste, qui marche sans serveur.</p>
      </header>

      <div className="exporter-corps">
        {erreur === undefined ? null : <p className="erreur">{erreur}</p>}
        {info === undefined && erreur === undefined ? (
          <p className="chargement">Verification</p>
        ) : null}

        {info?.disponible === true ? (
          <>
            <p>
              {info.fichiers.toLocaleString("fr-FR")} fichiers, {formatSize(info.octets)} avant
              compression. Le zip se fabrique pendant le telechargement, compte quelques minutes.
            </p>
            <p>
              <a className="bouton-telecharger" href="lite.zip" download>
                Telecharger
              </a>
            </p>
          </>
        ) : null}

        {info !== undefined && !info.disponible ? (
          <p className="erreur">
            Export indisponible, il manque {info.manquant.join(", ")} sur le serveur.
          </p>
        ) : null}

        <h2>Pour l ouvrir</h2>
        <p>
          Dezippe, double-clique sur <code>archive.html</code>, puis choisis <code>index.db</code>{" "}
          quand la page le demande. Tout reste sur ton poste.
        </p>
        <p>Les pieces jointes ne sont pas dedans, juste leur nom et leur taille.</p>
      </div>
    </section>
  );
}
