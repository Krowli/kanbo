import { BOARD_POSTGRES_TABLES } from './schema'

/** The role a person connects as: the board, whole. */
export const BOARD_PERSON_ROLE = 'kanban_person'

/** The role an agent connects as: the board, minus the two decisions that are a person's. */
export const BOARD_AGENT_ROLE = 'kanban_agent'

/**
 * What the database says when the agent role tries to take a card back from a
 * person. The board's clients turn it into `board_approval_requires_user`;
 * it is written here because by then the only thing left of the refusal is this
 * sentence.
 */
export const AGENT_WAITING_REFUSAL = 'kanbo: only a person may take a card out of waiting'

/** What the database says when the agent role tries to write a person's decision into the history. */
export const AGENT_APPROVAL_COMMENT_REFUSAL = 'kanbo: only a person may approve or return a card'

/**
 * `insufficient_privilege` — the SQLSTATE every refusal above is raised with,
 * and the one thing about them that survives a driver. A caller that maps the
 * refusal to an answer of its own matches this rather than the sentence.
 */
export const BOARD_REFUSAL_ERRCODE = '42501'

/**
 * The sequences behind the four `seq` columns — the board's stand-in for the
 * `rowid` a file orders by. An insert into one of those tables draws from its
 * sequence, so a role without `usage` on it cannot write the row at all.
 */
const BOARD_SEQUENCES = [
  'issue_runs_seq_seq',
  'issue_comments_seq_seq',
  'issue_field_changes_seq_seq',
  'issue_pull_requests_seq_seq',
]

/** The cards themselves — the one table the agent role may not delete from. */
const ISSUES_TABLE = 'issues'

/** Everything else, which both roles hold outright. */
const AGENT_DELETABLE_TABLES = BOARD_POSTGRES_TABLES.filter(table => table !== ISSUES_TABLE)

/** Every board table, as the SQL spells a list of them. */
function quoted(tables: readonly string[]): string {
  return tables.map(table => `"${table}"`).join(', ')
}

/**
 * The two roles an external board is worked through, and the two rules the
 * database itself keeps.
 *
 * A board in a file is protected by whoever can open the file. A board in a
 * shared database is not: several people and several agents connect to it at
 * once, from machines nobody else knows about, so the rule that approving is
 * a person's job has to live somewhere they all pass through. That is here —
 * below every client, in triggers that read `current_user`, so an agent holding
 * a connection string still cannot do a person's two things:
 *
 * - take a card out of `waiting_for = 'human'`, which is how a person accepts
 *   or returns the work, and
 * - write a `system.approved` or `system.returned` comment, which is how that
 *   decision is recorded — nor delete one, nor rewrite one, because a rule
 *   about who may write a row is worth nothing if the other side may erase or
 *   re-word it afterwards.
 *
 * The third rule is a grant rather than a trigger: the agent role may not
 * delete a card at all. A trigger cannot answer this one, because a cascading
 * delete is carried out as the owner of the table it reaches — `current_user`
 * inside the comment guard is the owner, not the agent, so deleting the card
 * would quietly take the decision on it with it. Nothing is lost by refusing:
 * the board's own tools offer no way to delete a card (cancelling one is a move
 * to another column), and a card that could be deleted and written again is a
 * way around waiting for a person.
 *
 * The guards read `current_user`, which is the role the session *logged in as*:
 * a login merely granted membership in `kanban_agent` is still itself, and the
 * rules below do not fire for it. The header of the SQL says so to whoever
 * applies it.
 *
 * Everything else about the board is the agent's to do. Both roles are created
 * with `login` and **no password**: an administrator sets one with
 * `alter role kanban_agent with password '…'` before a connection string is
 * handed out, and no password is ever written by this package.
 *
 * Applying this twice is a no-op — `kanbo roles apply` is meant to be run
 * again whenever the board moves or the rules change.
 */
export const BOARD_ROLE_SQL = `-- Two roles for one board: a person's and an agent's.
-- Apply as the owner of the board tables (or a superuser):
--   psql "$KANBO_DATABASE_URL" -f roles.sql
-- Neither role is given a password here. Set one before handing out a
-- connection string:
--   alter role ${BOARD_AGENT_ROLE} with password '…';
-- The agent role is granted no delete on "issues": see the comment on that
-- grant below.
-- Connect AS the role. The guards below read current_user, and a login that was
-- merely granted membership ("create role bot login; grant ${BOARD_AGENT_ROLE} to bot;")
-- keeps current_user = 'bot' — the guards then never fire and the board looks
-- configured while nothing is enforced. Either hand out ${BOARD_AGENT_ROLE}'s own
-- connection string, or have the session run "set role ${BOARD_AGENT_ROLE}" before it
-- touches the board.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = '${BOARD_PERSON_ROLE}') then
    create role "${BOARD_PERSON_ROLE}" login;
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = '${BOARD_AGENT_ROLE}') then
    create role "${BOARD_AGENT_ROLE}" login;
  end if;
end
$$;

grant usage on schema public to "${BOARD_PERSON_ROLE}", "${BOARD_AGENT_ROLE}";

grant select, insert, update, delete on ${quoted(BOARD_POSTGRES_TABLES)}
  to "${BOARD_PERSON_ROLE}";

-- The agent holds everything but the deletion of a card. A card carries its
-- history by cascade, and a cascading delete runs as the table's owner, so a
-- trigger on the comments cannot tell an agent's deletion from anyone's: the
-- only place to say it is here. The board's own tools never delete a card —
-- cancelling one is a move to another column — and a card that could be deleted
-- and written again is a way around waiting for a person.
grant select, insert, update, delete on ${quoted(AGENT_DELETABLE_TABLES)}
  to "${BOARD_AGENT_ROLE}";

grant select, insert, update on "${ISSUES_TABLE}" to "${BOARD_AGENT_ROLE}";
revoke delete on "${ISSUES_TABLE}" from "${BOARD_AGENT_ROLE}";

grant usage, select on sequence ${quoted(BOARD_SEQUENCES)}
  to "${BOARD_PERSON_ROLE}", "${BOARD_AGENT_ROLE}";

-- A person accepts or returns the work; an agent asks and waits.
create or replace function kanban_guard_waiting_for() returns trigger
language plpgsql as $$
begin
  if current_user = '${BOARD_AGENT_ROLE}'
    and old.waiting_for = 'human'
    and new.waiting_for is distinct from old.waiting_for then
    raise exception '${AGENT_WAITING_REFUSAL}' using errcode = '${BOARD_REFUSAL_ERRCODE}';
  end if;
  return new;
end;
$$;

drop trigger if exists kanban_guard_waiting_for on "issues";
create trigger kanban_guard_waiting_for
  before update on "issues"
  for each row execute function kanban_guard_waiting_for();

-- And the same decision, said in the card's history.
create or replace function kanban_guard_approval_comments() returns trigger
language plpgsql as $$
begin
  if current_user = '${BOARD_AGENT_ROLE}'
    and new.author_kind in ('system.approved', 'system.returned') then
    raise exception '${AGENT_APPROVAL_COMMENT_REFUSAL}' using errcode = '${BOARD_REFUSAL_ERRCODE}';
  end if;
  return new;
end;
$$;

drop trigger if exists kanban_guard_approval_comments on "issue_comments";
create trigger kanban_guard_approval_comments
  before insert on "issue_comments"
  for each row execute function kanban_guard_approval_comments();

-- And the same decision cannot be erased either: a rule about who may write a
-- row is worth nothing if the other side may delete it afterwards.
create or replace function kanban_guard_approval_comment_deletes() returns trigger
language plpgsql as $$
begin
  if current_user = '${BOARD_AGENT_ROLE}'
    and old.author_kind in ('system.approved', 'system.returned') then
    raise exception '${AGENT_APPROVAL_COMMENT_REFUSAL}' using errcode = '${BOARD_REFUSAL_ERRCODE}';
  end if;
  return old;
end;
$$;

drop trigger if exists kanban_guard_approval_comment_deletes on "issue_comments";
create trigger kanban_guard_approval_comment_deletes
  before delete on "issue_comments"
  for each row execute function kanban_guard_approval_comment_deletes();

-- Nor rewritten. A decision that can be re-worded, re-dated or turned into
-- something else is not a decision, and an update is how each of those is
-- spelled: "set content", "set created_at", "set author_kind = 'agent'". The
-- row is guarded coming and going — what it already is, and what it is being
-- made into — so the agent can neither take a person's decision away nor turn
-- its own comment into one.
create or replace function kanban_guard_approval_comment_updates() returns trigger
language plpgsql as $$
begin
  if current_user = '${BOARD_AGENT_ROLE}'
    and (old.author_kind in ('system.approved', 'system.returned')
      or new.author_kind in ('system.approved', 'system.returned')) then
    raise exception '${AGENT_APPROVAL_COMMENT_REFUSAL}' using errcode = '${BOARD_REFUSAL_ERRCODE}';
  end if;
  return new;
end;
$$;

drop trigger if exists kanban_guard_approval_comment_updates on "issue_comments";
create trigger kanban_guard_approval_comment_updates
  before update on "issue_comments"
  for each row execute function kanban_guard_approval_comment_updates();
`
