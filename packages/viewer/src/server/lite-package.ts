import { readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { ZipFile } from "yazl";

export interface LitePackageSources {
  /** Index construit par mmarchive-index. */
  readonly indexPath: string;
  /** Frontend a servir en statique, produit par vite build. */
  readonly webRoot: string | undefined;
  /** Fichier unique ouvrable par double clic, produit par build-standalone. */
  readonly standalonePath: string | undefined;
}

export interface LitePackagePlan {
  readonly entries: readonly { readonly source: string; readonly target: string }[];
  /** Somme des tailles avant compression, pour annoncer l ordre de grandeur. */
  readonly rawBytes: number;
  readonly missing: readonly string[];
}

const LISEZMOI = `Archive Mattermost, copie autonome
==================================

Cette copie se consulte de deux manieres, sans rien installer.

1. Par double clic
   Ouvrez archive.html, puis designez index.db quand la page le demande.
   Rien n est televerse : le fichier est lu sur place, par tranches.

2. Servie par un serveur de fichiers
   Placez le contenu du dossier web/ et index.db au meme endroit, puis servez
   ce dossier avec n importe quel serveur statique. L index est lu par plages :
   le serveur doit repondre aux requetes Range et ne pas recompresser les
   reponses, faute de quoi les plages demandees ne correspondraient plus au
   fichier.

Ce que cette copie contient
---------------------------

Les messages, les canaux, les comptes, les reactions, les avatars et les emojis
personnalises. La recherche fonctionne hors ligne, sur la totalite des messages.

Ce qu elle ne contient pas
--------------------------

Le contenu des pieces jointes. Leur nom, leur taille et leur type sont conserves
et affiches, mais les fichiers eux memes restent dans l archive d origine : ils
pesent plusieurs dizaines de gigaoctets.

Sont egalement absents, et le sont definitivement : les messages supprimes avant
l extraction, l historique des editions, et les canaux qui n ont pas ete
selectionnes. Le manifeste de l archive d origine en rend compte.
`;

async function walk(root: string, prefix: string): Promise<{ source: string; target: string }[]> {
  const out: { source: string; target: string }[] = [];
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const source = join(entry.parentPath, entry.name);
    // Les chemins d une archive zip utilisent toujours la barre oblique.
    const target = `${prefix}/${relative(root, source).split(sep).join("/")}`;
    out.push({ source, target });
  }
  return out;
}

/**
 * Etablit la liste de ce que la copie contiendra.
 *
 * Separee de l ecriture pour pouvoir etre annoncee a l utilisateur avant qu il
 * ne lance un telechargement de plusieurs centaines de megaoctets, et pour
 * signaler ce qui manque plutot que de produire une copie muette et incomplete.
 */
export async function planLitePackage(sources: LitePackageSources): Promise<LitePackagePlan> {
  const entries: { source: string; target: string }[] = [];
  const missing: string[] = [];
  let rawBytes = 0;

  try {
    rawBytes += (await stat(sources.indexPath)).size;
    entries.push({ source: sources.indexPath, target: "index.db" });
  } catch {
    missing.push("index.db");
  }

  if (sources.standalonePath === undefined) missing.push("archive.html");
  else {
    try {
      rawBytes += (await stat(sources.standalonePath)).size;
      entries.push({ source: sources.standalonePath, target: "archive.html" });
    } catch {
      missing.push("archive.html");
    }
  }

  if (sources.webRoot === undefined) missing.push("web/");
  else {
    try {
      const files = await walk(sources.webRoot, "web");
      for (const file of files) rawBytes += (await stat(file.source)).size;
      entries.push(...files);
    } catch {
      missing.push("web/");
    }
  }

  return { entries, rawBytes, missing };
}

/**
 * Assemble la copie en flux.
 *
 * Rien n est mis en memoire : l index depasse la demi douzaine de centaines de
 * megaoctets, et le tenir entier pour l envoyer irait contre la regle qui
 * gouverne tout ce projet. yazl lit chaque fichier au fur et a mesure et bascule
 * seul en zip64 quand la taille l exige.
 */
export function streamLitePackage(plan: LitePackagePlan): NodeJS.ReadableStream {
  const zip = new ZipFile();
  for (const entry of plan.entries) {
    // Tout est comprime, index compris : mesure sur l archive de reference,
    // 655 Mo tombent a 317 Mo en une vingtaine de secondes de calcul, faites au
    // fil de l envoi. Un tiers qui recoit cette copie la telecharge une fois.
    zip.addFile(entry.source, entry.target, { compress: true });
  }
  zip.addBuffer(Buffer.from(LISEZMOI, "utf8"), "LISEZMOI.txt");
  zip.end();
  return zip.outputStream;
}
