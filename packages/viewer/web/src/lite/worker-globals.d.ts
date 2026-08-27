/**
 * FileReaderSync n existe que dans un worker, et les types DOM ne le declarent
 * pas. Mélanger la bibliothèque WebWorker avec DOM ferait entrer en conflit des
 * dizaines de définitions globales, pour un seul type manquant.
 */
declare class FileReaderSync {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
  readAsText(blob: Blob, encoding?: string): string;
}
