import type { ReadBackend } from "./block-cache.js";

export type { ReadBackend };

/**
 * Sources de lecture d un index, pour le mode sans serveur.
 *
 * Les deux sont SYNCHRONES, et c est la contrainte qui commande tout le reste :
 * SQLite ne sait pas rendre la main au milieu d une requete. Or les deux seules
 * lectures synchrones du navigateur, FileReaderSync et XMLHttpRequest bloquant,
 * n existent que dans un worker. C est pourquoi tout ce module y tourne.
 *
 * La parade habituelle, SharedArrayBuffer plus Atomics.wait, est indisponible
 * ici : une page ouverte depuis le disque n est jamais isolee d origine croisee.
 */
export class ReadBackendError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReadBackendError";
  }
}

/** Lecture d un fichier designe par l utilisateur, pour l ouverture en double-clic. */
export function createFileBackend(file: File): ReadBackend {
  const reader = new FileReaderSync();
  return {
    size: file.size,
    label: file.name,
    read(offset, length) {
      const slice = file.slice(offset, offset + length);
      return new Uint8Array(reader.readAsArrayBuffer(slice));
    },
  };
}

function requestRange(url: string, offset: number, length: number): XMLHttpRequest {
  const request = new XMLHttpRequest();
  // Le troisieme argument a false rend la requete bloquante. Interdit sur le
  // fil principal, autorise dans un worker, et seul moyen de servir un VFS.
  request.open("GET", url, false);
  request.responseType = "arraybuffer";
  request.setRequestHeader("Range", `bytes=${String(offset)}-${String(offset + length - 1)}`);
  request.send();
  return request;
}

/**
 * Lecture par plages HTTP, pour un index pose sur un hebergement statique.
 *
 * Le serveur doit repondre 206 et ne pas recompresser : un intermediaire qui
 * gzippe la reponse fait porter la plage sur les octets compresses, et le
 * client lit alors des pages incoherentes en croyant que tout va bien.
 */
export function createHttpBackend(url: string): ReadBackend {
  const probe = new XMLHttpRequest();
  probe.open("HEAD", url, false);
  probe.send();
  if (probe.status < 200 || probe.status >= 300) {
    throw new ReadBackendError(`Index introuvable a ${url} (statut ${String(probe.status)}).`);
  }
  const length = probe.getResponseHeader("content-length");
  const size = length === null ? Number.NaN : Number(length);
  if (!Number.isFinite(size) || size <= 0) {
    throw new ReadBackendError(`Taille de l index inconnue a ${url}.`);
  }

  const first = requestRange(url, 0, 1);
  if (first.status !== 206) {
    throw new ReadBackendError(
      `L hebergement de ${url} ne repond pas aux requetes par plage (statut ${String(first.status)}). Un index de plusieurs centaines de megaoctets ne peut pas etre lu autrement.`,
    );
  }
  if ((first.getResponseHeader("content-encoding") ?? "") !== "") {
    throw new ReadBackendError(
      `L hebergement de ${url} recompresse les reponses : les plages demandees ne correspondent alors plus au fichier. Servez l index sans compression.`,
    );
  }

  return {
    size,
    label: url,
    read(offset, readLength) {
      const request = requestRange(url, offset, readLength);
      // Un 200 porte le fichier entier, pas la plage demandee. L accepter ferait
      // prendre le debut du fichier pour le bloc situe a cet offset, et SQLite
      // lirait des pages incoherentes sans que rien ne signale l erreur.
      if (request.status !== 206) {
        throw new ReadBackendError(
          request.status === 200
            ? `L hebergement de ${url} a ignore la plage demandee et renvoye le fichier entier. Un index de cette taille ne peut pas etre lu ainsi.`
            : `Lecture refusee a l offset ${String(offset)} (statut ${String(request.status)}).`,
        );
      }
      const body: unknown = request.response;
      if (!(body instanceof ArrayBuffer)) {
        throw new ReadBackendError("Reponse illisible pour une plage.");
      }
      return new Uint8Array(body);
    },
  };
}
