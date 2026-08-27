import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { App } from "./App.js";
import type { ArchiveClient } from "./client/archive-client.js";
import { HttpArchiveClient } from "./client/http-client.js";
import { ArchiveProvider, type LoadState } from "./data.js";
import { WorkerArchiveClient } from "./lite/worker-client.js";

/** Nom attendu de l index pose a cote de la page, en hebergement statique. */
const STATIC_INDEX = "index.db";

export type Mode =
  | { readonly kind: "serveur" }
  | { readonly kind: "statique" }
  /** Page ouverte depuis le disque : rien ne peut etre charge sans geste. */
  | { readonly kind: "fichier" };

/**
 * Determine comment l archive peut etre lue.
 *
 * Ouverte depuis le disque, une page ne peut emettre aucune requete, pas meme
 * vers le fichier d a cote : seul un fichier designe par l utilisateur est
 * lisible. Servie par un serveur, elle interroge l API. Servie en statique, elle
 * lit l index par plages.
 */
export async function detectMode(): Promise<Mode> {
  if (globalThis.location.protocol === "file:") return { kind: "fichier" };
  try {
    const response = await fetch("api/meta", { method: "HEAD" });
    if (response.ok) return { kind: "serveur" };
  } catch {
    // Pas d API : reste l hypothese d un index pose en statique.
  }
  return { kind: "statique" };
}

/**
 * Code du worker, injecte par le bundle autonome.
 *
 * Chrome refuse de charger un module depuis file:// : l origine y est nulle et
 * la politique d origine croisee s applique meme au fichier d a cote. Le seul
 * worker constructible est donc un worker bati depuis une URL blob, a partir de
 * son code source.
 */
declare const __MMARCHIVE_WORKER_SOURCE__: string | undefined;

function createWorker(): Worker {
  const inlined =
    typeof __MMARCHIVE_WORKER_SOURCE__ === "undefined" ? undefined : __MMARCHIVE_WORKER_SOURCE__;
  if (inlined !== undefined) {
    const url = URL.createObjectURL(new Blob([inlined], { type: "text/javascript" }));
    return new Worker(url);
  }
  return new Worker(new URL("./lite/worker.js", import.meta.url), { type: "module" });
}

function Accueil({
  onFile,
  erreur,
  occupe,
  mode,
}: {
  onFile(file: File): void;
  readonly erreur: string | undefined;
  readonly occupe: boolean;
  readonly mode: Mode;
}): ReactNode {
  const input = useRef<HTMLInputElement | null>(null);
  const [survol, setSurvol] = useState(false);

  const prendre = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file !== undefined) onFile(file);
    },
    [onFile],
  );

  return (
    <div className="ecran-etat">
      <div className="ouverture">
        <h1>Archive</h1>
        <p className="vue-detail">
          {mode.kind === "fichier"
            ? "Cette page est ouverte depuis un disque : elle ne peut lire aucun fichier de son propre chef. Designez l index de l archive pour la consulter."
            : "Aucun index n a ete trouve a cote de cette page. Designez le fichier a consulter."}
        </p>
        <button
          type="button"
          className={survol ? "depot survol" : "depot"}
          disabled={occupe}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setSurvol(true);
          }}
          onDragLeave={() => {
            setSurvol(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setSurvol(false);
            prendre(event.dataTransfer.files);
          }}
        >
          {occupe ? "Ouverture" : "Choisir index.db, ou le deposer ici"}
        </button>
        <input
          ref={input}
          type="file"
          hidden
          onChange={(event) => {
            prendre(event.target.files);
          }}
        />
        {erreur === undefined ? null : <p className="erreur">{erreur}</p>}
        <p className="vue-detail">
          Rien n est televerse : le fichier est lu sur place, page par page, sans jamais quitter cet
          ordinateur.
        </p>
      </div>
    </div>
  );
}

function Fallback(state: LoadState): ReactNode {
  if (state.status === "erreur") {
    return (
      <div className="ecran-etat">
        <h1>Archive illisible</h1>
        <p className="erreur">{state.message}</p>
      </div>
    );
  }
  return (
    <div className="ecran-etat">
      <p className="chargement">Ouverture de l archive</p>
    </div>
  );
}

export function Boot(): ReactNode {
  // La detection precede tout le reste et ne peut pas se faire avant le rendu :
  // un await de premier niveau est interdit dans le bundle autonome, qui doit
  // etre un script classique pour etre chargeable depuis un disque.
  const [mode, setMode] = useState<Mode | undefined>();
  const [client, setClient] = useState<ArchiveClient | undefined>();
  const [erreur, setErreur] = useState<string | undefined>();
  const [occupe, setOccupe] = useState(false);

  useEffect(() => {
    void detectMode().then((detected) => {
      setMode(detected);
      if (detected.kind === "serveur") setClient(new HttpArchiveClient());
      else if (detected.kind === "statique") setOccupe(true);
    });
  }, []);

  const ouvrir = useCallback(async (worker: WorkerArchiveClient, ouverture: Promise<void>) => {
    try {
      await ouverture;
      // Les emojis personnalises sont prepares avant le premier affichage : le
      // rendu Markdown produit du balisage et ne peut pas attendre une image.
      await worker.preloadEmojis();
      setClient(worker);
    } catch (cause) {
      setErreur(cause instanceof Error ? cause.message : "index illisible");
      setOccupe(false);
    }
  }, []);

  useEffect(() => {
    if (mode?.kind !== "statique") return;
    const worker = new WorkerArchiveClient(createWorker());
    // Adresse resolue depuis la page : dans le worker, une adresse relative se
    // resoudrait depuis le script du worker, donc depuis le dossier des assets.
    void ouvrir(worker, worker.openUrl(new URL(STATIC_INDEX, globalThis.location.href).href));
  }, [mode?.kind, ouvrir]);

  const ouvrirFichier = useCallback(
    (file: File) => {
      setOccupe(true);
      setErreur(undefined);
      const worker = new WorkerArchiveClient(createWorker());
      void ouvrir(worker, worker.openFile(file));
    },
    [ouvrir],
  );

  if (mode === undefined) {
    return (
      <div className="ecran-etat">
        <p className="chargement">Ouverture de l archive</p>
      </div>
    );
  }

  if (client === undefined) {
    return <Accueil onFile={ouvrirFichier} erreur={erreur} occupe={occupe} mode={mode} />;
  }

  return (
    <ArchiveProvider client={client} fallback={Fallback}>
      <App />
    </ArchiveProvider>
  );
}
