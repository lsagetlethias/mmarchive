import { MM } from "./endpoints.js";
import { ConsentViolationError } from "./errors.js";
import type { RawExecutor } from "./http-client.js";

/**
 * Consentement explicite de l utilisateur a modifier l instance Mattermost.
 *
 * Rejoindre un canal publie un message systeme visible par tous ses membres.
 * mmarchive ne le fait donc jamais de sa propre initiative : chaque canal doit
 * figurer nominativement ici, apres avoir ete coche dans le fichier de selection
 * ET confirme au lancement.
 */
export interface MutationConsent {
  readonly channelIds: ReadonlySet<string>;
  readonly teamIds: ReadonlySet<string>;
  readonly grantedAt: string;
  /**
   * "interactive" : confirmation saisie au clavier.
   * "flag_yes"    : court-circuitee par --yes, mais la selection reste explicite.
   * "none"        : aucun consentement, aucune mutation possible. C est le mode
   *                 par defaut, celui du run sans --file.
   */
  readonly source: "interactive" | "flag_yes" | "none";
}

/** Consentement vide : toute tentative de mutation sera refusee. */
export function noConsent(): MutationConsent {
  return {
    channelIds: new Set(),
    teamIds: new Set(),
    grantedAt: "",
    source: "none",
  };
}

export function grantConsent(input: {
  channelIds: readonly string[];
  teamIds: readonly string[];
  grantedAt: string;
  source: "interactive" | "flag_yes";
}): MutationConsent {
  return {
    channelIds: new Set(input.channelIds),
    teamIds: new Set(input.teamIds),
    grantedAt: input.grantedAt,
    source: input.source,
  };
}

export interface PerformedMutation {
  readonly kind: "join_channel" | "leave_channel" | "join_team";
  readonly targetId: string;
  readonly at: string;
}

export interface MutationGateOptions {
  readonly executor: RawExecutor;
  readonly consent: MutationConsent;
  /** Identifiant du compte porteur du token, cible des ajouts de membre. */
  readonly selfUserId: string;
  /** Canaux rejoints par l outil lors d un run precedent, lus dans le state file. */
  readonly previouslyJoinedChannelIds?: readonly string[] | undefined;
  readonly clock?: (() => string) | undefined;
}

/**
 * Seul chemin de mmarchive vers une requete qui modifie l instance.
 *
 * Le client HTTP refuse tout endpoint marque mutant ; il ne fournit un
 * executeur brut qu a cette classe, qui verifie le consentement avant chaque
 * appel. Court-circuiter la porte demande donc de modifier deux fichiers, ce qui
 * ne peut pas passer inapercu en relecture.
 */
export class MutationGate {
  private readonly executor: RawExecutor;
  private readonly consent: MutationConsent;
  private readonly selfUserId: string;
  private readonly joinedByTool: Set<string>;
  private readonly clock: () => string;
  private readonly performedMutations: PerformedMutation[] = [];

  constructor(options: MutationGateOptions) {
    this.executor = options.executor;
    this.consent = options.consent;
    this.selfUserId = options.selfUserId;
    this.joinedByTool = new Set(options.previouslyJoinedChannelIds ?? []);
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  get performed(): readonly PerformedMutation[] {
    return this.performedMutations;
  }

  /** Canaux effectivement rejoints par l outil, run precedent inclus. */
  get channelsJoinedByTool(): readonly string[] {
    return [...this.joinedByTool];
  }

  hasConsentForChannel(channelId: string): boolean {
    return this.consent.channelIds.has(channelId);
  }

  async joinChannel(channelId: string): Promise<PerformedMutation> {
    if (!this.consent.channelIds.has(channelId)) {
      throw new ConsentViolationError("canal", channelId);
    }
    await this.executor(MM.addChannelMember(channelId, this.selfUserId));
    this.joinedByTool.add(channelId);
    return this.record("join_channel", channelId);
  }

  async joinTeam(teamId: string): Promise<PerformedMutation> {
    if (!this.consent.teamIds.has(teamId)) {
      throw new ConsentViolationError("team", teamId);
    }
    await this.executor(MM.addTeamMember(teamId, this.selfUserId));
    return this.record("join_team", teamId);
  }

  /**
   * Quitte un canal, uniquement s il a ete rejoint par l outil.
   *
   * Garde-fou capital : sans cette verification, un --leave-after ferait sortir
   * l utilisateur de canaux dont il etait membre depuis toujours. La perte
   * serait invisible et irrattrapable sur une instance en fin de vie.
   */
  async leaveChannel(channelId: string): Promise<PerformedMutation> {
    if (!this.joinedByTool.has(channelId)) {
      throw new ConsentViolationError("canal", channelId);
    }
    await this.executor(MM.removeChannelMember(channelId, this.selfUserId));
    this.joinedByTool.delete(channelId);
    return this.record("leave_channel", channelId);
  }

  private record(kind: PerformedMutation["kind"], targetId: string): PerformedMutation {
    const mutation: PerformedMutation = { kind, targetId, at: this.clock() };
    this.performedMutations.push(mutation);
    return mutation;
  }
}
