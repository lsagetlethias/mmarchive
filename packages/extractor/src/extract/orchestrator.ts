import { mkdir } from "node:fs/promises";
import {
  type ArchiveChannel,
  type ArchiveTeam,
  type ArchiveWarning,
  CHANNEL_TYPE,
  describeError,
  type JoinedChannelRecord,
  type Manifest,
  SCHEMA_VERSION,
  type SelectionFile,
  type SelectionMode,
} from "@mmarchive/shared";
import { countNdjsonLines, NdjsonWriter, readNdjson } from "@mmarchive/shared/ndjson";
import { type ArchivePaths, createArchivePaths } from "../archive/paths.js";
import { StateStore } from "../archive/state-store.js";
import type { RunOptions } from "../config/options.js";
import type { MattermostApi } from "../mattermost/api.js";
import type { MattermostClient } from "../mattermost/http-client.js";
import { grantConsent, MutationGate, noConsent } from "../mattermost/mutation-gate.js";
import type { MmChannel, MmFileInfo, MmTeam, MmUser } from "../mattermost/types.js";
import type { Logger } from "../ui/logger.js";
import { RunReporter } from "../ui/run-reporter.js";
import { TOOL_VERSION } from "../version.js";
import { extractEmojis, extractFiles, extractUsers, repairMissingFiles } from "./assets.js";
import { extractChannelPosts } from "./channel-posts.js";
import { buildPlan, type ExtractionPlan } from "./plan.js";

export interface RunExtractionOptions {
  readonly api: MattermostApi;
  readonly client: MattermostClient;
  readonly account: MmUser;
  readonly runOptions: RunOptions;
  readonly selection: SelectionFile;
  readonly selectionMode: SelectionMode;
  readonly totalPublicChannels: number;
  readonly logger: Logger;
  /**
   * Demande le consentement de l utilisateur pour les joins. Renvoyer false
   * annule l extraction. C est le SEUL chemin par lequel un join peut etre
   * autorise.
   */
  readonly confirmJoins: (plan: ExtractionPlan) => Promise<boolean>;
  /** Affichage de l avancement. Desactive dans les tests. */
  readonly reporter?: RunReporter | undefined;
  readonly clock?: (() => string) | undefined;
}

export class ExtractionCancelled extends Error {
  constructor() {
    super("Extraction annulee : aucun canal n a ete rejoint, rien n a ete modifie.");
    this.name = "ExtractionCancelled";
  }
}

/**
 * Auteurs et pieces jointes citees par les messages deja archives d un canal.
 * Sert a rattraper ce qu une session precedente a ecrit sans le declarer.
 */
async function collectFromArchivedPosts(
  postsFile: string,
): Promise<{ userIds: Set<string>; fileIds: Set<string> }> {
  const userIds = new Set<string>();
  const fileIds = new Set<string>();
  try {
    for await (const post of readNdjson<{
      user_id: string;
      file_ids?: string[];
      reactions?: { user_id: string }[];
    }>(postsFile)) {
      if (post.user_id.length > 0) userIds.add(post.user_id);
      for (const reaction of post.reactions ?? []) userIds.add(reaction.user_id);
      for (const fileId of post.file_ids ?? []) fileIds.add(fileId);
    }
  } catch {
    // Fichier absent : rien a rattraper, l anomalie est signalee ailleurs.
  }
  return { userIds, fileIds };
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      await worker(item, index);
    }
  });
  await Promise.all(runners);
}

function toArchiveTeam(
  team: SelectionFile["teams"][number],
  fiche: MmTeam | undefined,
  joinedByTool: boolean,
): ArchiveTeam {
  return {
    id: team.id,
    name: team.name,
    display_name: team.display_name,
    description: fiche?.description ?? "",
    type: fiche?.type ?? "",
    create_at: fiche?.create_at ?? 0,
    delete_at: fiche?.delete_at ?? 0,
    was_joined_by_tool: joinedByTool,
  };
}

export async function runExtraction(options: RunExtractionOptions): Promise<Manifest> {
  const { api, runOptions, logger } = options;
  const clock = options.clock ?? (() => new Date().toISOString());
  const startedAt = clock();
  const paths: ArchivePaths = createArchivePaths(runOptions.out);
  await mkdir(paths.root, { recursive: true });

  const plan = buildPlan(options.selection);
  const warnings: ArchiveWarning[] = [];

  for (const skipped of plan.skipped) {
    warnings.push({
      code: "ARCHIVED_CHANNEL_FORBIDDEN",
      channel_id: skipped.channel.id,
      detail: `Canal archive "${skipped.channel.name}" illisible, ecarte de l extraction.`,
    });
  }

  // Consentement. Sans accord explicite, la porte reste fermee et toute
  // tentative de join leve une erreur plutot que de modifier l instance.
  let consent = noConsent();
  if (plan.joins.length > 0) {
    const accepted = await options.confirmJoins(plan);
    if (!accepted) throw new ExtractionCancelled();
    consent = grantConsent({
      channelIds: plan.joins.map((join) => join.channel.id),
      teamIds: runOptions.joinTeams ? plan.teamsToJoin : [],
      grantedAt: clock(),
      source: runOptions.yes ? "flag_yes" : "interactive",
    });
  }

  const fingerprint = [
    String(runOptions.includeEmails),
    String(runOptions.skipFiles),
    String(runOptions.maxFileSizeBytes),
    String(runOptions.since ?? ""),
  ].join("|");

  const reporter =
    options.reporter ??
    new RunReporter({
      estimatedMessages: plan.channels.reduce((sum, c) => sum + c.channel.message_count, 0),
    });
  reporter.start();

  const existing = runOptions.resume
    ? await StateStore.load(paths.state, {
        sourceUrl: runOptions.connection.url,
        accountId: options.account.id,
        optionsFingerprint: fingerprint,
      })
    : null;

  const state =
    existing ??
    StateStore.create(paths.state, {
      startedAt,
      sourceUrl: runOptions.connection.url,
      accountId: options.account.id,
      optionsFingerprint: fingerprint,
    });

  /**
   * Un Ctrl+C tue le processus sans laisser la sauvegarde periodique aboutir.
   * On force donc l ecriture de l etat avant de sortir : sans cela la reprise
   * rejouerait tout le travail depuis la derniere sauvegarde, et surtout la
   * liste des canaux rejoints pourrait etre perdue.
   */
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupted) return;
    interrupted = true;
    reporter.note(`Interruption (${signal}) : sauvegarde de l etat en cours...`);
    void state
      .close()
      .catch(() => undefined)
      .finally(() => {
        reporter.stop();
        process.exit(130);
      });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const gate = new MutationGate({
    executor: options.client.createRawExecutor(),
    consent,
    selfUserId: options.account.id,
    previouslyJoinedChannelIds: state.state.joined_channels.map((record) => record.id),
    clock,
  });

  // Joins, un par un, consignes AVANT toute lecture : un crash ne doit pas
  // faire perdre la trace de ce que l outil a modifie sur l instance.
  if (runOptions.joinTeams) {
    for (const teamId of plan.teamsToJoin) {
      await gate.joinTeam(teamId);
      state.state.joined_teams.push({ id: teamId, name: teamId, joined_at: clock() });
      await state.saveNow();
      logger.info(`Team rejointe : ${teamId}`);
    }
  }

  const joinedByTool = new Set<string>(state.state.joined_channels.map((r) => r.id));
  for (const join of plan.joins) {
    if (joinedByTool.has(join.channel.id)) continue;
    await gate.joinChannel(join.channel.id);
    const record: JoinedChannelRecord = {
      id: join.channel.id,
      name: join.channel.name,
      team_id: join.teamId,
      joined_at: clock(),
      left: false,
    };
    state.state.joined_channels.push(record);
    joinedByTool.add(join.channel.id);
    await state.saveNow();
    logger.warn(`Canal rejoint : ${join.channel.name} (un message systeme y a ete publie)`);
  }

  // Emojis : une seule fois pour toute l archive. C est la premiere etape du
  // run et elle peut durer une minute, d ou son affichage explicite.
  if (!state.state.emojis_done) {
    reporter.phase("Emojis personnalises");
    const result = await extractEmojis({
      api,
      paths,
      includeEmails: runOptions.includeEmails,
      skipFiles: runOptions.skipFiles,
      maxFileSizeBytes: runOptions.maxFileSizeBytes,
      downloadConcurrency: runOptions.concurrency,
      onProgress: (done, total) => {
        if (total > 0) reporter.phaseTotalIs(total);
        reporter.phaseProgress(done);
        reporter.setRequestCount(options.client.requestCount);
      },
    });
    warnings.push(...result.warnings);
    // Un drapeau de progression ne se pose que sur un succes constate.
    if (result.listed) {
      state.state.emojis_done = true;
      state.touch();
      await state.saveNow();
    }
    reporter.note(`Emojis personnalises : ${String(result.count)}`);
  }

  reporter.phase("Canaux", plan.channels.length, { estimate: true });

  // Construit une seule fois : le reconstruire a chaque canal devenait
  // quadratique a mesure que la liste des pieces jointes grossissait.
  const downloadedFileIds = new Set<string>(state.state.downloaded_file_ids);

  const allUserIds = new Set<string>();
  /**
   * Canaux extraits INTEGRALEMENT pendant cette session, donc dont tous les
   * messages ont ete lus en memoire. Un canal repris a mi-parcours n en fait
   * pas partie : sa portion heritee doit etre relue.
   */
  const fullyExtractedThisSession = new Set<string>();
  // Ces bornes sont ecrites depuis des taches concurrentes : les porter dans un
  // objet evite que le controle de flux ne les considere figees a null.
  const range: { first: number | null; last: number | null } = { first: null, last: null };
  let attachments = 0;
  let attachmentBytes = state.state.attachments_bytes;

  await mapWithConcurrency(plan.channels, runOptions.concurrency, async (planned) => {
    const channelId = planned.channel.id;
    const progress = state.progressFor(channelId);
    if (progress.status === "complete") {
      logger.debug(`Canal deja extrait, ignore : ${planned.channel.name}`);
      reporter.channelSkipped(progress.posts_written);
      return;
    }

    reporter.channelStarted(planned.channel.display_name || planned.channel.name);

    /**
     * Les messages sont deja finalises : seules les pieces jointes restent.
     *
     * Ce cas apparait quand une session s arrete entre la finalisation des
     * posts et la fin de leur phase de pieces jointes. Rejouer la pagination
     * ne rapporterait rien et risquerait d ecraser un fichier complet ; on
     * relit donc les file_ids depuis les messages deja ecrits.
     */
    if (progress.finalized && progress.posts_written > 0) {
      const inherited = await collectFromArchivedPosts(paths.postsFile(channelId));
      for (const userId of inherited.userIds) allUserIds.add(userId);
      for (const fileId of inherited.fileIds) referencedFileIds.set(fileId, channelId);
      state.updateProgress(channelId, { status: "complete" });
      await state.saveNow();
      reporter.channelEnded(planned.channel.display_name || planned.channel.name);
      reporter.channelSkipped(progress.posts_written);
      return;
    }

    // Les messages epingles ne conditionnent pas la premiere page : les attendre
    // laisserait le slot avec une seule requete en vol la ou il peut en avoir
    // deux. Sur un canal median de deux pages, c est un tiers des aller-retours.
    const pinnedPromise = api.getPinnedPostIds(channelId);
    pinnedPromise.catch(() => undefined);

    let files: readonly MmFileInfo[];
    let postsWritten: number;
    // Un canal repris conserve des messages ecrits par une session anterieure.
    const startedFromScratch = progress.posts_written === 0;
    try {
      const result = await extractChannelPosts({
        api,
        channelId,
        paths,
        progress,
        sinceMillis: runOptions.since,
        perPage: runOptions.postsPageSize,
        pinnedIds: pinnedPromise,
        onCursor: async (patch) => {
          state.updateProgress(channelId, patch);
          reporter.setRequestCount(options.client.requestCount);
          await state.saveThrottled();
        },
      });

      files = result.files;
      warnings.push(...result.warnings);
      for (const userId of result.userIds) allUserIds.add(userId);
      if (result.firstCreateAt !== null) {
        range.first =
          range.first === null ? result.firstCreateAt : Math.min(range.first, result.firstCreateAt);
      }
      if (result.lastCreateAt !== null) {
        range.last =
          range.last === null ? result.lastCreateAt : Math.max(range.last, result.lastCreateAt);
      }

      // Le canal n est PAS encore marque complete : ses pieces jointes ne sont
      // pas ecrites. Le marquer ici et mourir juste apres les perdrait
      // definitivement, la reprise ignorant les canaux complets. Constate sur
      // une archive reelle, 3 736 pieces jointes referencees sans metadonnee.
      postsWritten = result.postsWritten;
      state.updateProgress(channelId, {
        finalized: true,
        posts_written: result.postsWritten,
      });
      await state.saveNow();
      if (startedFromScratch) fullyExtractedThisSession.add(channelId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "erreur inconnue";
      warnings.push({ code: "CHANNEL_INCOMPLETE", channel_id: channelId, detail });
      state.updateProgress(channelId, { status: "failed", error: detail });
      await state.saveNow();
      reporter.note(`[erreur] ${planned.channel.name} : ${detail}`);
      reporter.channelEnded(planned.channel.display_name || planned.channel.name);
      reporter.channelFinished(0);
      return;
    }

    const fileResult = await extractFiles({
      api,
      paths,
      channelId,
      files,
      includeEmails: runOptions.includeEmails,
      skipFiles: runOptions.skipFiles,
      maxFileSizeBytes: runOptions.maxFileSizeBytes,
      downloadConcurrency: runOptions.concurrency,
      alreadyDone: downloadedFileIds,
    });
    warnings.push(...fileResult.warnings);
    attachments += fileResult.downloaded;
    attachmentBytes += fileResult.bytes;
    reporter.filesAdded(fileResult.downloaded);
    reporter.setRequestCount(options.client.requestCount);

    // Le canal n est complet qu une fois ses pieces jointes decrites.
    state.updateProgress(channelId, { status: "complete" });
    await state.saveNow();
    reporter.channelEnded(planned.channel.display_name || planned.channel.name);
    reporter.channelFinished(postsWritten);
    for (const file of files) {
      if (downloadedFileIds.has(file.id)) continue;
      downloadedFileIds.add(file.id);
      state.state.downloaded_file_ids.push(file.id);
    }
    state.state.attachments_bytes = attachmentBytes;
    state.touch();
    await state.saveThrottled();
  });

  /**
   * Complete la liste des auteurs en relisant les messages deja archives.
   *
   * allUserIds ne contient que les auteurs vus pendant CETTE session. Apres une
   * reprise, ou apres un run interrompu avant l etape des utilisateurs, les
   * auteurs des canaux repris n auraient jamais de fiche : l archive
   * referencerait des user_id introuvables. Constate sur une archive reelle,
   * 2 084 auteurs sans fiche.
   */
  /** Pieces jointes citees par un message, avec le canal qui les cite. */
  const referencedFileIds = new Map<string, string>();
  /**
   * Tous les canaux termines sont relus, pas seulement ceux que la session n a
   * pas touches.
   *
   * Un canal interrompu puis acheve a la session suivante figure bien dans
   * extractedThisSession, alors que la portion heritee de son fichier de
   * travail n a jamais ete relue : ses auteurs et ses pieces jointes
   * manquaient. C est le defaut meme que ce rattrapage devait fermer, branche
   * sur le mauvais predicat.
   */
  const resumedChannels = plan.channels.filter(
    (planned) => !fullyExtractedThisSession.has(planned.channel.id),
  );
  if (resumedChannels.length > 0) {
    reporter.phase("Relecture des auteurs", resumedChannels.length);
    let scanned = 0;
    for (const planned of resumedChannels) {
      const progress = state.progressFor(planned.channel.id);
      scanned += 1;
      reporter.phaseProgress(scanned);
      if (progress.status !== "complete") continue;
      try {
        for await (const post of readNdjson<{
          user_id: string;
          file_ids?: string[];
          reactions?: { user_id: string }[];
        }>(paths.postsFile(planned.channel.id))) {
          if (post.user_id.length > 0) allUserIds.add(post.user_id);
          for (const reaction of post.reactions ?? []) allUserIds.add(reaction.user_id);
          for (const fileId of post.file_ids ?? []) {
            referencedFileIds.set(fileId, planned.channel.id);
          }
        }
      } catch {
        // Fichier absent ou illisible : deja signale par ailleurs.
      }
    }
  }

  if (referencedFileIds.size > 0) {
    const described = new Set<string>();
    try {
      for await (const entry of readNdjson<{ id: string }>(paths.files)) described.add(entry.id);
    } catch {
      // Fichier absent : tout est a decrire.
    }
    const orphans = [...referencedFileIds].filter(([id]) => !described.has(id));
    if (orphans.length > 0) {
      reporter.phase("Pieces jointes manquantes", orphans.length);
      const repaired = await repairMissingFiles({
        api,
        paths,
        includeEmails: runOptions.includeEmails,
        skipFiles: runOptions.skipFiles,
        maxFileSizeBytes: runOptions.maxFileSizeBytes,
        downloadConcurrency: runOptions.concurrency,
        missing: orphans.map(([id, channelId]) => ({ id, channelId })),
        onProgress: (done) => {
          reporter.phaseProgress(done);
          reporter.setRequestCount(options.client.requestCount);
        },
      });
      warnings.push(...repaired.warnings);
      attachments += repaired.downloaded;
      attachmentBytes += repaired.bytes;
      reporter.filesAdded(repaired.downloaded);
    }
  }

  reporter.phase("Utilisateurs et avatars", allUserIds.size);
  const usersResult = await extractUsers({
    api,
    paths,
    userIds: allUserIds,
    includeEmails: runOptions.includeEmails,
    skipFiles: runOptions.skipFiles,
    maxFileSizeBytes: runOptions.maxFileSizeBytes,
    downloadConcurrency: runOptions.concurrency,
    onProgress: (done, total) => {
      if (total > 0) reporter.phaseTotalIs(total);
      reporter.phaseProgress(done);
      reporter.setRequestCount(options.client.requestCount);
    },
  });
  warnings.push(...usersResult.warnings);
  state.state.fetched_user_ids = [...new Set([...state.state.fetched_user_ids, ...allUserIds])];
  state.touch();

  // Compte relu sur le fichier plutot que sur le resultat de l extraction :
  // en reprise, les emojis ne sont pas reextraits et le compteur serait a zero.
  /**
   * Compteurs relus sur les fichiers de l archive, pas cumules sur la session.
   * Apres une reprise, les totaux de la session ne decrivent qu une fraction du
   * contenu, et le manifeste doit rester auditable.
   */
  const countLines = async (file: string): Promise<number> => {
    try {
      return await countNdjsonLines(file);
    } catch {
      return 0;
    }
  };
  /**
   * Plage temporelle de l archive entiere, relue dans l etat de chaque canal.
   * Les bornes de la session ne couvrent que les canaux traites cette fois-ci.
   */
  const archiveRange = ((): { first_create_at: number; last_create_at: number } | undefined => {
    let first: number | null = null;
    let last: number | null = null;
    for (const planned of plan.channels) {
      const progress = state.progressFor(planned.channel.id);
      if (progress.status !== "complete") continue;
      const oldest = progress.oldest_create_at;
      const newest = progress.newest_create_at;
      if (oldest !== null && oldest > 0) first = first === null ? oldest : Math.min(first, oldest);
      if (newest !== null && newest > 0) last = last === null ? newest : Math.max(last, newest);
    }
    if (first === null || last === null) return undefined;
    return { first_create_at: first, last_create_at: last };
  })();

  const userCount = await countLines(paths.users);
  // Pieces jointes reellement presentes : celles dont le binaire manque gardent
  // leur metadonnee mais ne doivent pas etre comptees comme archivees.
  let attachmentsOnDisk = 0;
  try {
    for await (const entry of readNdjson<{ path: string | null }>(paths.files)) {
      if (entry.path !== null) attachmentsOnDisk += 1;
    }
  } catch {
    attachmentsOnDisk = attachments;
  }

  let emojiCount: number;
  try {
    emojiCount = await countNdjsonLines(paths.emojis);
  } catch {
    // Le fichier peut ne pas exister si le listing des emojis a echoue : c est
    // deja consigne en warning, le compteur reste simplement a zero.
    emojiCount = 0;
  }

  reporter.phase("Finalisation");
  /**
   * Decrit tous les canaux presents dans l archive, pas seulement ceux extraits
   * pendant cette session.
   *
   * Le fichier est reecrit a chaque run : n y mettre que le travail de la
   * session laissait une archive dont les posts existaient sans que le canal
   * correspondant ne soit decrit. Constate sur une archive reelle, 758 fichiers
   * de posts pour 120 canaux decrits.
   */
  const complets = plan.channels.filter(
    (planned) => state.progressFor(planned.channel.id).status === "complete",
  );

  /**
   * Fiches completes des canaux, relues juste avant d ecrire.
   *
   * Le catalogue de selection ne transporte que ce qui sert a choisir : l objet,
   * l en-tete et la date de creation n y figurent pas. Les relire ici plutot que
   * de les faire transiter par le YAML garde ce fichier lisible, et surtout
   * empeche qu un YAML edite a la main dicte le contenu de l archive.
   *
   * Un echec ne fait pas echouer l extraction : une metadonnee manquante ne vaut
   * pas la perte de plusieurs heures de messages deja ecrits. Elle est consignee
   * en avertissement, et le champ reste vide comme avant.
   */
  const fiches = new Map<string, MmChannel>();
  reporter.phase("Metadonnees des canaux");
  await mapWithConcurrency(complets, runOptions.concurrency, async (planned) => {
    try {
      fiches.set(planned.channel.id, await api.getChannel(planned.channel.id));
    } catch (error) {
      warnings.push({
        code: "METADATA_FETCH_FAILED",
        channel_id: planned.channel.id,
        detail: `Fiche du canal "${planned.channel.name}" illisible : ${describeError(error)}`,
      });
    }
  });

  const archivedChannels: ArchiveChannel[] = [];
  for (const planned of complets) {
    const progress = state.progressFor(planned.channel.id);
    const fiche = fiches.get(planned.channel.id);
    archivedChannels.push({
      id: planned.channel.id,
      team_id: planned.teamId,
      name: planned.channel.name,
      display_name: planned.channel.display_name,
      type: CHANNEL_TYPE.PUBLIC,
      header: fiche?.header ?? "",
      purpose: fiche?.purpose ?? "",
      create_at: fiche?.create_at ?? 0,
      // La fiche fait foi quand on l a : un canal archive entre l inventaire et
      // le run porte la date de son archivage, la selection ne connait qu un
      // booleen.
      delete_at: fiche?.delete_at ?? (planned.channel.archived ? 1 : 0),
      total_msg_count: planned.channel.message_count,
      last_post_at: progress.newest_create_at ?? 0,
      was_joined_by_tool: joinedByTool.has(planned.channel.id),
      archived_post_count: progress.posts_written,
    });
  }

  const teamsWriter = await NdjsonWriter.open(paths.teams);
  try {
    const usedTeamIds = new Set(archivedChannels.map((c) => c.team_id));
    for (const team of options.selection.teams) {
      if (!usedTeamIds.has(team.id)) continue;
      let fiche: MmTeam | undefined;
      try {
        fiche = await api.getTeam(team.id);
      } catch (error) {
        warnings.push({
          code: "METADATA_FETCH_FAILED",
          team_id: team.id,
          detail: `Fiche de la team "${team.name}" illisible : ${describeError(error)}`,
        });
      }
      await teamsWriter.write(
        toArchiveTeam(
          team,
          fiche,
          state.state.joined_teams.some((t) => t.id === team.id),
        ),
      );
    }
  } finally {
    await teamsWriter.close();
  }

  /**
   * Messages reellement presents, comptes sur les fichiers. L etat peut diverger
   * du disque, et le manifeste est la seule piece auditable une fois l instance
   * disparue : il doit decrire ce qui existe, pas ce qui etait prevu.
   */
  let postsOnDisk = 0;
  for (const channel of archivedChannels) {
    const real = await countLines(paths.postsFile(channel.id));
    postsOnDisk += real;
    if (real !== channel.archived_post_count) {
      warnings.push({
        code: "CHANNEL_INCOMPLETE",
        channel_id: channel.id,
        detail: `L etat annonce ${String(channel.archived_post_count)} messages, le fichier en contient ${String(real)}.`,
      });
    }
  }

  const channelsWriter = await NdjsonWriter.open(paths.channels);
  try {
    await channelsWriter.writeMany(archivedChannels);
  } finally {
    await channelsWriter.close();
  }

  // Depart optionnel. Il publie un SECOND message systeme, d ou le defaut a
  // false : sur une instance en fin de vie, partir ne fait que doubler le bruit.
  if (runOptions.leaveAfter) {
    for (const record of state.state.joined_channels) {
      if (record.left) continue;
      try {
        await gate.leaveChannel(record.id);
        record.left = true;
        record.left_at = clock();
        await state.saveNow();
      } catch (error) {
        warnings.push({
          code: "LEAVE_FAILED",
          channel_id: record.id,
          detail: error instanceof Error ? error.message : "erreur inconnue",
        });
      }
    }
  }

  /**
   * Les avertissements decrivent l archive, pas la session : les vider a chaque
   * run effacait la trace des pieces jointes manquantes et des fils orphelins
   * des runs precedents. On cumule en dedupliquant, les canaux retraites
   * reproduisant naturellement les leurs.
   */
  const warningKey = (w: ArchiveWarning): string =>
    `${w.code}|${w.channel_id ?? ""}|${w.team_id ?? ""}|${w.detail}`;
  const mergedWarnings = new Map<string, ArchiveWarning>();
  for (const w of [...state.state.warnings, ...warnings]) {
    mergedWarnings.set(warningKey(w), w);
  }
  const allWarnings = [...mergedWarnings.values()];
  state.state.warnings = allWarnings;
  state.touch();

  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    tool_version: TOOL_VERSION,
    source: { url: runOptions.connection.url, server_version: api.serverVersion },
    extracted_at: startedAt,
    extracted_by: {
      user_id: options.account.id,
      username: options.account.username,
      was_system_admin: options.selection.meta.account.is_system_admin,
    },
    selection: {
      mode: options.selectionMode,
      channels_total_public: options.totalPublicChannels,
      channels_selected: plan.channels.length,
      channels_already_member: plan.channels.filter((c) => c.channel.joined).length,
      channels_joined_by_tool: state.state.joined_channels.length,
      channels_archived: plan.channels.filter((c) => c.channel.archived).length,
    },
    options: {
      include_emails: runOptions.includeEmails,
      skip_files: runOptions.skipFiles,
      leave_after: runOptions.leaveAfter,
      max_file_size_mb: Math.round(runOptions.maxFileSizeBytes / (1024 * 1024)),
      concurrency: runOptions.concurrency,
      rate_limit: runOptions.rateLimit,
      ...(runOptions.since === undefined
        ? {}
        : { since: new Date(runOptions.since).toISOString() }),
    },
    joined_channels: state.state.joined_channels,
    joined_teams: state.state.joined_teams,
    counts: {
      teams: new Set(plan.channels.map((c) => c.teamId)).size,
      channels: archivedChannels.length,
      posts: postsOnDisk,
      users: userCount,
      emojis: emojiCount,
      attachments: attachmentsOnDisk,
      attachments_bytes: attachmentBytes,
    },
    ...(archiveRange === undefined ? {} : { post_range: archiveRange }),
    warnings: allWarnings,
  };

  await state.close();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  reporter.stop();
  return manifest;
}
