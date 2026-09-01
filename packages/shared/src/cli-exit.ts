/**
 * Codes de sortie des binaires, decides en un seul endroit.
 *
 * Le README les annonce comme exploitables par un script : 0 succes, 1 echec,
 * 2 argument invalide. Deux binaires sur quatre tenaient cette promesse, les
 * deux autres laissaient commander appliquer son defaut et sortaient en 1 sur
 * une option inconnue. `mmarchive-index` etait meme incoherent avec lui-meme,
 * sortant en 2 sur une valeur invalide et en 1 sur une option invalide.
 *
 * Les demandes d aide et de version passent par le meme chemin d erreur chez
 * commander alors qu elles sont des succes, d ou la liste ci-dessous. Elle
 * nomme aussi les codes qu une version ulterieure de commander pourrait
 * ajouter : tout ce qui n y figure pas est traite comme une saisie fautive, et
 * le code 1 reste reserve a ce qui echoue pendant le travail lui-meme.
 */
const SORTIES_NORMALES = new Set([
  "commander.help",
  "commander.helpDisplayed",
  "commander.version",
]);

/** Code de sortie a appliquer pour une erreur levee par commander. */
export function codeDeSortieCommander(code: string): number {
  return SORTIES_NORMALES.has(code) ? 0 : 2;
}
