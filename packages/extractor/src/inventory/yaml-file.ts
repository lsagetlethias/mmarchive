import { readFile, writeFile } from "node:fs/promises";
import {
  categorizeChannel,
  ERROR_CODES,
  type ErrorCode,
  type SelectionFile,
  type SelectionSummary,
  selectionFileSchema,
  summarizeSelection,
} from "@mmarchive/shared";
import {
  Document,
  isMap,
  isScalar,
  isSeq,
  type Pair,
  parse as parseYaml,
  type YAMLMap,
} from "yaml";

export class SelectionFileError extends Error {
  readonly code: ErrorCode = ERROR_CODES.SelectionFileError;
  readonly filePath: string;

  constructor(filePath: string, detail: string) {
    super(`Fichier de selection ${filePath} inutilisable : ${detail}`);
    this.name = "SelectionFileError";
    this.filePath = filePath;
  }
}

function pairOf(node: YAMLMap, key: string): Pair | undefined {
  return node.items.find((item) => String(item.key) === key);
}

/**
 * Valeur JavaScript d une cle. Indispensable : les valeurs d un Document yaml
 * sont des noeuds Scalar, et une comparaison directe a true renverrait toujours
 * false sans ce dereferencement.
 */
function scalarValue(node: YAMLMap, key: string): unknown {
  const pair = pairOf(node, key);
  if (pair === undefined) return undefined;
  return isScalar(pair.value) ? pair.value.value : pair.value;
}

/** Attache un commentaire de fin de ligne a une paire cle/valeur. */
function commentValue(node: YAMLMap, key: string, comment: string): void {
  const pair = pairOf(node, key);
  if (pair === undefined) return;
  // Sur un Scalar fraichement construit, la propriete comment n existe pas
  // encore : un test "comment" in value renverrait false a tort.
  if (isScalar(pair.value)) {
    pair.value.comment = ` ${comment}`;
  }
}

function buildHeader(file: SelectionFile, summary: SelectionSummary): string {
  const account = file.meta.account;
  const role = account.is_system_admin ? "system_admin" : "standard, non system_admin";
  const lines = [
    ` Genere le ${file.meta.generated_at} depuis ${file.meta.source_url}`,
    ` Compte: ${account.username} (${role})`,
    ` Outil: mmarchive ${file.meta.tool_version}`,
    "",
    " selected: true  -> le canal sera extrait.",
    " Les canaux joined: false ET selected: true declencheront un join,",
    " qui publie un message systeme visible par tous les membres du canal.",
    " Un canal archived: true n est jamais joignable, il n induit donc aucun join.",
    "",
    ` Total actuellement selectionne: ${String(summary.channelsSelected)} canaux sur ${String(
      summary.channelsTotal,
    )}, environ ${summary.estimatedMessages.toLocaleString("fr-FR")} messages, ${String(
      summary.joinsInduced,
    )} join${summary.joinsInduced > 1 ? "s" : ""}.`,
  ];

  if (summary.joinsInduced > 0) {
    lines.push(
      "",
      ` ATTENTION: la selection actuelle publiera ${String(
        summary.joinsInduced,
      )} message(s) systeme sur l instance.`,
      " Canaux concernes:",
      ...summary.channelsRequiringJoin.map((channel) => `   - ${channel.name}`),
    );
  }

  if (summary.unreadableSelected > 0) {
    lines.push(
      "",
      ` ${String(summary.unreadableSelected)} canal(aux) selectionne(s) sont illisibles et seront ignores.`,
    );
  }

  return lines.join("\n");
}

/**
 * Rend le fichier de selection. Les commentaires ne sont pas decoratifs : ils
 * sont le seul endroit ou l utilisateur voit, avant d agir, combien de messages
 * systeme sa selection va publier.
 */
export function renderSelectionFile(file: SelectionFile, summary?: SelectionSummary): string {
  const computed = summary ?? summarizeSelection(file);
  const doc = new Document(file);
  doc.commentBefore = buildHeader(file, computed);

  const teamsNode: unknown = doc.get("teams", true);
  if (isSeq(teamsNode)) {
    for (const teamItem of teamsNode.items) {
      if (!isMap(teamItem)) continue;
      const teamMap = teamItem;
      if (scalarValue(teamMap, "joined") === false) {
        commentValue(teamMap, "joined", "compte NON membre de cette team");
      }
      const channelsNode: unknown = teamMap.get("channels", true);
      if (!isSeq(channelsNode)) continue;

      for (const channelItem of channelsNode.items) {
        if (!isMap(channelItem)) continue;
        const channelMap = channelItem;
        const joined = scalarValue(channelMap, "joined") === true;
        const archived = scalarValue(channelMap, "archived") === true;
        const readableRaw = scalarValue(channelMap, "readable");
        const readable = readableRaw === undefined ? undefined : readableRaw === true;

        const category = categorizeChannel({ joined, archived, readable });
        switch (category) {
          case "member":
            commentValue(channelMap, "joined", "deja membre, aucun effet de bord");
            break;
          case "readable_without_join":
            commentValue(channelMap, "readable", "lisible sans rejoindre");
            break;
          case "join_required":
            commentValue(channelMap, "joined", "JOIN REQUIS: publiera un message systeme");
            break;
          case "archived_readable":
            commentValue(channelMap, "archived", "archive, lisible, non joignable");
            break;
          case "archived_unreadable":
            commentValue(channelMap, "archived", "archive et ILLISIBLE, sera ignore");
            break;
        }
      }
    }
  }

  return doc.toString({ lineWidth: 0 });
}

export function parseSelectionFile(text: string, filePath: string): SelectionFile {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new SelectionFileError(
      filePath,
      `YAML invalide (${error instanceof Error ? error.message : "erreur inconnue"}).`,
    );
  }

  const result = selectionFileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "racine"} : ${issue.message}`)
      .join("\n  ");
    throw new SelectionFileError(
      filePath,
      `structure inattendue.\n  ${issues}\n  Regenerer le fichier avec: mmarchive-extract inventory`,
    );
  }
  return result.data;
}

export async function readSelectionFile(filePath: string): Promise<SelectionFile> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "";
    if (code === "ENOENT") {
      throw new SelectionFileError(
        filePath,
        `fichier introuvable. Lancer d abord: mmarchive-extract inventory --out ${filePath}`,
      );
    }
    throw new SelectionFileError(filePath, "lecture impossible.");
  }
  return parseSelectionFile(text, filePath);
}

export async function writeSelectionFile(
  filePath: string,
  file: SelectionFile,
  summary?: SelectionSummary,
): Promise<void> {
  await writeFile(filePath, renderSelectionFile(file, summary), "utf8");
}
