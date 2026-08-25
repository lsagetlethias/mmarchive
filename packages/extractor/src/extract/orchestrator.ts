import { mkdir } from "node:fs/promises";
import {
  CHANNEL_TYPE,
  SCHEMA_VERSION,
  type ArchiveChannel,
  type ArchiveTeam,
  type ArchiveWarning,
  type JoinedChannelRecord,
  type Manifest,
  type SelectionFile,
  type SelectionMode,
} from "@mmarchive/shared";
import { NdjsonWriter, countNdjsonLines, readNdjson } from "../archive/ndjson.js";
import { createArchivePaths, type ArchivePaths } from "../archive/paths.js";
import { StateStore } from "../archive/state-store.js";
import type { RunOptions } from "../config/options.js";
import type { MattermostApi } from "../mattermost/api.js";
import type { MattermostClient } from "../mattermost/http-client.js";
import { MutationGate, grantConsent, noConsent } from "../mattermost/mutation-gate.js";
import type { MmFileInfo, MmUser } from "../mattermost/types.js";
import type { Logger } from "../ui/logger.js";
import { RunReporter } from "../ui/run-reporter.js";
import { extractEmojis, extractFiles, extractUsers } from "./assets.js";
import { extractChannelPosts } from "./channel-posts.js";
import { buildPlan, type ExtractionPlan } from "./plan.js";
import { TOOL_VERSION } from "../version.js";

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

function toArchiveTeam(team: SelectionFile["teams"][number], joinedByTool: boolean): ArchiveTeam {
  return {
    id: team.id,
    name: team.name,
    display_name: team.display_name,
    description: "",
    type: "",
    create_at: 0,
    delete_at: 0,
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
    state.state.emojis_done = true;
    await state.saveNow();
    reporter.note(`Emojis personnalises : ${String(result.count)}`);
  }

  reporter.phase("Canaux", plan.channels.length, { estimate: true });

  // Construit une seule fois : le reconstruire a chaque canal devenait
  // quadratique a mesure que la liste des pieces jointes grossissait.
  const downloadedFileIds = new Set<string>(state.state.downloaded_file_ids);

  const allUserIds = new Set<string>();
  /** Canaux extraits pendant cette session : les autres sont a relire. */
  const extractedThisSession = new Set<string>();
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
    // Les messages epingles ne conditionnent pas la premiere page : les attendre
    // laisserait le slot avec une seule requete en vol la ou il peut en avoir
    // deux. Sur un canal median de deux pages, c est un tiers des aller-retours.
    const pinnedPromise = api.getPinnedPostIds(channelId);
    pinnedPromise.catch(() => undefined);

    let files: readonly MmFileInfo[];
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

      state.updateProgress(channelId, {
        status: "complete",
        finalized: true,
        posts_written: result.postsWritten,
      });
      await state.saveNow();
      extractedThisSession.add(channelId);
      reporter.channelEnded(planned.channel.display_name || planned.channel.name);
      reporter.channelFinished(result.postsWritten);
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
    for (const file of files) {
      if (downloadedFileIds.has(file.id)) continue;
      downloadedFileIds.add(file.id);
      state.state.downloaded_file_ids.push(file.id);
    }
    state.state.attachments_bytes = attachmentBytes;
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
  const resumedChannels = plan.channels.filter(
    (planned) => !extractedThisSession.has(planned.channel.id),
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
        for await (const post of readNdjson<{ user_id: string; reactions?: { user_id: string }[] }>(
          paths.postsFile(planned.channel.id),
        )) {
          if (post.user_id.length > 0) allUserIds.add(post.user_id);
          for (const reaction of post.reactions ?? []) allUserIds.add(reaction.user_id);
        }
      } catch {
        // Fichier absent ou illisible : deja signale par ailleurs.
      }
    }
  }

  reporter.phase("Utilisateurs et avatars", allUserIds.size);
  const usersResult = await extractUsers({
    api,
    paths,
    userIds: allUserIds,
    alreadyDone: new Set(state.state.fetched_user_ids),
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
  state.state.fetched_user_ids.push(...allUserIds);

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
  const archivedChannels: ArchiveChannel[] = [];
  for (const planned of plan.channels) {
    const progress = state.progressFor(planned.channel.id);
    if (progress.status !== "complete") continue;
    archivedChannels.push({
      id: planned.channel.id,
      team_id: planned.teamId,
      name: planned.channel.name,
      display_name: planned.channel.display_name,
      type: CHANNEL_TYPE.PUBLIC,
      header: "",
      purpose: "",
      create_at: 0,
      delete_at: planned.channel.archived ? 1 : 0,
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
      await teamsWriter.write(
        toArchiveTeam(
          team,
          state.state.joined_teams.some((t) => t.id === team.id),
        ),
      );
    }
  } finally {
    await teamsWriter.close();
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
      posts: archivedChannels.reduce((sum, c) => sum + c.archived_post_count, 0),
      users: userCount,
      emojis: emojiCount,
      attachments: attachmentsOnDisk,
      attachments_bytes: attachmentBytes,
    },
    ...(range.first === null || range.last === null
      ? {}
      : { post_range: { first_create_at: range.first, last_create_at: range.last } }),
    warnings: [...warnings, ...state.state.warnings],
  };

  state.state.warnings = [];
  await state.close();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  reporter.stop();
  return manifest;
}
