import type {
  Issue,
  IssueComment,
  issueComments,
  IssueFieldChange,
  issueFieldChanges,
  IssueMilestone,
  issueMilestones,
  IssuePullRequest,
  issuePullRequests,
  IssueRelation,
  issueRelations,
  IssueRun,
  issueRuns,
  issues,
  IssueStatus,
  issueStatuses,
  KanbanMeta,
} from './sqlite/schema'

/** Workflow statuses of a workspace. */
export interface IssueStatusStore {
  /** Statuses of one workspace, in board order. */
  listByWorkspace: (workspaceId: string) => Promise<IssueStatus[]>
  /** Every status, grouped by workspace, in board order within each workspace. */
  listAllInBoardOrder: () => Promise<IssueStatus[]>
  /** Every status, in no particular order. */
  listAll: () => Promise<IssueStatus[]>
  findById: (statusId: string) => Promise<IssueStatus | null>
  /**
   * The status, read inside a write so no other writer can put a card in it or
   * delete it until this transaction ends: `select … for update` on Postgres.
   * A SQLite write already holds the whole file (`begin immediate`), so there
   * it is `findById`.
   */
  lockById: (statusId: string) => Promise<IssueStatus | null>
  /** The status, only when it belongs to the given workspace. */
  findInWorkspace: (workspaceId: string, statusId: string) => Promise<IssueStatus | null>
  countByWorkspace: (workspaceId: string) => Promise<number>
  create: (values: typeof issueStatuses.$inferInsert) => Promise<IssueStatus>
  update: (statusId: string, patch: Partial<typeof issueStatuses.$inferInsert>) => Promise<void>
  delete: (statusId: string) => Promise<void>
}

/** Milestones of a workspace. */
export interface IssueMilestoneStore {
  /** Milestones, newest first. `null` spans every workspace. */
  listNewestFirst: (workspaceId: string | null) => Promise<IssueMilestone[]>
  /** Milestones of one workspace, in no particular order. */
  listByWorkspace: (workspaceId: string) => Promise<IssueMilestone[]>
  /** Every milestone, in no particular order. */
  listAll: () => Promise<IssueMilestone[]>
  findById: (milestoneId: string) => Promise<IssueMilestone | null>
  /** The milestone, only when it belongs to the given workspace. */
  findInWorkspace: (workspaceId: string, milestoneId: string) => Promise<IssueMilestone | null>
  create: (values: typeof issueMilestones.$inferInsert) => Promise<IssueMilestone>
  update: (milestoneId: string, patch: Partial<typeof issueMilestones.$inferInsert>) => Promise<void>
  delete: (milestoneId: string) => Promise<void>
}

/** Issue rows themselves. */
export interface IssueRowStore {
  /** Issues in board order (`order`, then newest first). `null` spans every workspace. */
  listInBoardOrder: (workspaceId: string | null) => Promise<Issue[]>
  /** Every issue, newest first. */
  listNewestFirst: () => Promise<Issue[]>
  /** Every issue, in no particular order. */
  listAll: () => Promise<Issue[]>
  /** Issues of one workspace, in no particular order. */
  listByWorkspace: (workspaceId: string) => Promise<Issue[]>
  /**
   * The cards of one workspace a query picks, in board order, one page of them,
   * and how many it picks in all — in one statement. The filters are conjoined;
   * a filter left out does not narrow.
   */
  listPage: (query: BoardCardQuery) => Promise<BoardCardPage>
  /**
   * How many cards of the workspace each milestone holds, per column — one
   * statement, cards with no milestone left out. What a sprint list counts.
   */
  countByMilestone: (workspaceId: string) => Promise<BoardMilestoneCardCount[]>
  /** Issues with the given ids, in no particular order. Missing ids are simply absent. */
  listByIds: (issueIds: string[]) => Promise<Issue[]>
  findById: (issueId: string) => Promise<Issue | null>
  /** The issue, only when it belongs to the given workspace. */
  findInWorkspace: (workspaceId: string, issueId: string) => Promise<Issue | null>
  /** The issue carrying that number inside the workspace — the uniqueness constraint behind key generation. */
  findByNumber: (workspaceId: string, number: number) => Promise<Issue | null>
  /** Highest issue number in the workspace, `0` when it holds no issues. */
  maxNumber: (workspaceId: string) => Promise<number>
  /** Highest board position in the workspace, `0` when it holds no issues. */
  maxOrder: (workspaceId: string) => Promise<number>
  create: (values: typeof issues.$inferInsert) => Promise<Issue>
  update: (issueId: string, patch: Partial<typeof issues.$inferInsert>) => Promise<void>
  /** Apply one patch to many issues; resolves to the number of rows written. */
  updateMany: (issueIds: string[], patch: Partial<typeof issues.$inferInsert>) => Promise<number>
  /** Detach every issue that points at the deleted milestone. */
  clearMilestoneReferences: (milestoneId: string, updatedAt: number) => Promise<void>
  /** Detach every child of the deleted parent issue. */
  clearParentReferences: (parentIssueId: string, updatedAt: number) => Promise<void>
  /**
   * Undelegate every card that names the deleted agent or provider target, and
   * say how many were written.
   *
   * Both columns are soft references — an agent and a provider target are
   * a host app's rows, and a board is carried by files that have no such tables
   * (ruling 5-1) — so nothing in the database undoes a delegation when the row
   * behind it goes. This is what the host calls instead, on every board it can
   * reach. A card keeps its delegate *kind* nowhere else, so both columns are
   * cleared together when either one matches.
   */
  clearDelegateReferences: (
    delegate: { agentId: string } | { providerTargetId: string },
    updatedAt: number,
  ) => Promise<number>
  delete: (issueId: string) => Promise<void>
}

/**
 * Which cards of a workspace `listPage` reads, and which page of them.
 *
 * Every filter is optional and they all apply together. Text is matched
 * ignoring case — ASCII case on SQLite, where `like` folds nothing else; every
 * letter on Postgres (`ilike`).
 */
export interface BoardCardQuery {
  workspaceId: string
  /** Cards in any of these columns. An empty list picks nothing. */
  statusIds?: readonly string[]
  /** `true`: only cards waiting for a person; `false`: only cards waiting for no one. */
  waitingForPerson?: boolean
  /** Only the cards directly under this card. */
  parentIssueId?: string
  /** `true`: only cards with a run going on now; `false`: only cards with none. */
  hasActiveRun?: boolean
  /**
   * `true`: only cards a person sent back that nobody has picked up again —
   * the card's latest decision (`system.approved` or `system.returned`
   * comment, the one `readApproval` reads) is a return, it is not waiting for a
   * person, and no run is going on on it. `false`: every other card.
   */
  returned?: boolean
  /** Cards whose key, title or description contains this text. */
  text?: string
  /** Cards changed at or after this moment, in unix seconds. */
  updatedSince?: number
  /** Cards carrying every one of these labels. */
  labels?: readonly string[]
  /** Cards of any of these priorities. An empty list picks nothing. */
  priorities?: readonly Issue['priority'][]
  /** How many picked cards to skip, in board order. */
  offset?: number
  /** How many picked cards to return at most; every one when absent. */
  limit?: number
}

/** One page of the cards a `BoardCardQuery` picks. */
export interface BoardCardPage {
  /** The page, in board order. */
  cards: Issue[]
  /** How many cards the query picks in all, before `offset` and `limit`. */
  total: number
}

/** How many cards of one milestone sit in one column. */
export interface BoardMilestoneCardCount {
  milestoneId: string
  statusId: string | null
  count: number
}

/** Comments on an issue. */
export interface IssueCommentStore {
  /** Comments of one issue, oldest first. */
  listByIssue: (issueId: string) => Promise<IssueComment[]>
  /**
   * The latest comment of each of these issues — among those of `authorKinds`
   * when given — in one statement, in no particular order. An issue with none
   * is absent. "Latest" is the order `listByIssue` lists them in, its last.
   */
  listLatestByIssues: (issueIds: readonly string[], authorKinds?: readonly IssueComment['authorKind'][]) => Promise<IssueComment[]>
  findById: (commentId: string) => Promise<IssueComment | null>
  /**
   * The comment on that issue carrying `dedupeKey`, or `null` — one read of the
   * unique `(issue_id, dedupe_key)` index. How a caller asks whether a card has
   * already said something without reading every comment it holds.
   */
  findByDedupeKey: (issueId: string, dedupeKey: string) => Promise<IssueComment | null>
  /**
   * The comments on that issue whose dedupe key starts with `prefix`, oldest
   * first — how a caller finds the newest of a family of keys (a verdict per
   * commit, say) without reading every comment the card holds. The prefix is
   * matched literally: no character in it is a wildcard.
   */
  listByDedupeKeyPrefix: (issueId: string, prefix: string) => Promise<IssueComment[]>
  create: (values: typeof issueComments.$inferInsert) => Promise<IssueComment>
  /**
   * Write the comment only if its issue does not carry `dedupeKey` yet, and
   * return whichever row holds the key afterwards — the one just written or the
   * one that was already there. The unique index on `(issue_id, dedupe_key)` is
   * what makes this safe against a concurrent writer, so there is no
   * read-then-write window to lose.
   */
  createOnce: (values: typeof issueComments.$inferInsert & { dedupeKey: string }) => Promise<IssueComment>
  delete: (commentId: string) => Promise<void>
}

/** One launch of a card, from the moment it starts until it ends. */
export interface IssueRunStore {
  /** Runs of one issue, oldest first. */
  listByIssue: (issueId: string) => Promise<IssueRun[]>
  /** Runs of one issue that are still `running`, oldest first. */
  listRunning: (issueId: string) => Promise<IssueRun[]>
  /**
   * Every run still `running` that a chat session was driving, of any issue,
   * oldest first.
   *
   * This is the board's answer to "what does the app that launched these still
   * believe it is running", and the one run listing that spans the whole store: a host coming
   * back up has no card in mind, it has a process that died under it. A run with
   * no session behind it is left out — it belongs to a host the board knows
   * nothing about, and is still going for all the board can tell.
   */
  listRunningWithSession: () => Promise<IssueRun[]>
  findById: (runId: string) => Promise<IssueRun | null>
  /** The newest run driving that chat session, across every issue. */
  findByChatSessionId: (chatSessionId: string) => Promise<IssueRun | null>
  /** How many runs the issue has ever had — the attempt number of the next one, minus one. */
  countByIssue: (issueId: string) => Promise<number>
  create: (values: typeof issueRuns.$inferInsert) => Promise<IssueRun>
  update: (runId: string, patch: Partial<typeof issueRuns.$inferInsert>) => Promise<void>
  /**
   * The run facts a card list needs, for every card in scope, in one statement:
   * how many runs it has had and which one is running now. Cards with no runs at
   * all are simply absent from the result.
   */
  project: (scope: BoardRunProjectionScope) => Promise<BoardRunProjection[]>
}

/** Which cards a projection covers: a whole workspace, or a named list. */
export type BoardRunProjectionScope
  = | { workspaceId: string }
    | { issueIds: string[] }

/** The run of a card that is going on right now. */
export interface BoardActiveRun {
  id: string
  agentId: string | null
  agentName: string
  state: IssueRun['state']
  branch: string | null
  executionMode: IssueRun['executionMode']
  chatSessionId: string | null
  startedAt: number
}

/** What the run table answers about one card. */
export interface BoardRunProjection {
  issueId: string
  /** Every run the card has ever had; the next launch is attempt `attemptCount + 1`. */
  attemptCount: number
  /** The `running` run, or `null` when the newest run of the card has already ended. */
  activeRun: BoardActiveRun | null
}

/**
 * The counters the board keeps for its readers, one row per key: `board`, bumped
 * once per write transaction that changed something, and `schema_epoch`, the
 * schema generation the file was written with.
 */
export interface KanbanMetaStore {
  read: (key: string) => Promise<KanbanMeta | null>
  /** Raise the key's revision by one, creating the row at `1` when it is missing. */
  bumpRevision: (key: string, updatedAt: number) => Promise<void>
}

/** Edges between issues. */
export interface IssueRelationStore {
  /** Every edge touching the issue, in either direction. */
  listByIssue: (issueId: string) => Promise<IssueRelation[]>
  findById: (relationId: string) => Promise<IssueRelation | null>
  /**
   * The edge the unique `(source, target, type)` constraint would collide with.
   * `relates_to` is undirected, so the reversed pair matches too.
   */
  findMatching: (edge: Pick<typeof issueRelations.$inferInsert, 'sourceIssueId' | 'targetIssueId' | 'type'>) => Promise<IssueRelation | null>
  create: (values: typeof issueRelations.$inferInsert) => Promise<IssueRelation>
  delete: (relationId: string) => Promise<void>
  /** Drop every edge touching the issue, in either direction. */
  deleteByIssue: (issueId: string) => Promise<void>
}

/**
 * Context refs attached to an issue. They live in a column today, so the store —
 * not the caller — owns how they are stored.
 */
export interface IssueContextRefStore {
  /** Replace the whole ref list of one issue with the serialized value the caller built. */
  replace: (issueId: string, contextRefs: Issue['contextRefs'], updatedAt: number) => Promise<void>
}

/** Append-only audit of issue field edits. */
export interface IssueFieldChangeStore {
  /** Field changes of one issue, oldest first. */
  listByIssue: (issueId: string) => Promise<IssueFieldChange[]>
  /** Field changes of one issue touching one field, oldest first. */
  listByIssueField: (issueId: string, field: string) => Promise<IssueFieldChange[]>
  create: (values: typeof issueFieldChanges.$inferInsert) => Promise<void>
}

/** A pull request a card names, with the workspace of that card — one row of `listLinked`. */
export type BoardLinkedPullRequest = IssuePullRequest & { workspaceId: string }

/** The pull requests cards name (ruling 4-1). The link only: what the pull request *is* stays GitHub's. */
export interface IssuePullRequestStore {
  /** Links of one card, in the order they were made. */
  listByIssue: (issueId: string) => Promise<IssuePullRequest[]>
  /**
   * Every link on the board, each with its card's workspace, in the order they
   * were made — what a watcher reading GitHub for the whole board walks.
   */
  listLinked: () => Promise<BoardLinkedPullRequest[]>
  /**
   * Name the pull request on the card, once. When the card already names that
   * `(owner, repo, number)` the standing row comes back and nothing is written —
   * the unique index settles a concurrent writer the same way.
   */
  link: (values: typeof issuePullRequests.$inferInsert) => Promise<IssuePullRequest>
  /** Drop one link of the card; the row that was removed, or `null` when the card named no such link. */
  unlink: (issueId: string, linkId: string) => Promise<IssuePullRequest | null>
}

/**
 * How the outer transaction takes its write lock. `deferred` — the SQLite
 * default — waits for the first write; `immediate` takes the lock up front, so
 * two writers racing for the same board fail fast instead of half-way through.
 * A transaction nested in another one takes no lock of its own, so the mode only
 * reaches the outermost one.
 *
 * It is a board *file*'s lock, and a store whose engine has none ignores the
 * mode entirely: Postgres locks rows as they are written, and the two races the
 * board actually has are settled without a lock of their own — two writers
 * numbering a card collide on the unique index over `(workspace_id, number)`,
 * and two writers bumping the change counter meet in the `on conflict do
 * update` on `kanban_meta`.
 */
export type BoardTransactionMode = 'deferred' | 'immediate'

/**
 * Storage boundary of the board.
 *
 * The store moves rows in and out of the board tables (`issues`,
 * `issue_statuses`, `issue_milestones`, `issue_comments`, `issue_runs`,
 * `issue_relations`, `issue_field_changes`, `issue_pull_requests`, `kanban_meta`
 * and context refs),
 * holds their integrity constraints,
 * and owns transactions across them. It carries no domain validation: a missing
 * row comes back as `null`, an empty result as `[]`.
 *
 * Rows other owners write — workspaces, agents, provider targets — are not part
 * of it. A host that needs them composes its own lookup group beside this one.
 */
export interface BoardStore {
  statuses: IssueStatusStore
  milestones: IssueMilestoneStore
  issues: IssueRowStore
  comments: IssueCommentStore
  runs: IssueRunStore
  relations: IssueRelationStore
  contextRefs: IssueContextRefStore
  fieldChanges: IssueFieldChangeStore
  pullRequests: IssuePullRequestStore
  meta: KanbanMetaStore
  /**
   * Run `fn` against a transactional view of the same store. Everything written
   * through `tx` commits together, or none of it does.
   */
  transaction: <T>(fn: (tx: BoardStore) => Promise<T>, options?: { mode?: BoardTransactionMode }) => Promise<T>
}
