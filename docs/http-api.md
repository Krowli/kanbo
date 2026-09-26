# HTTP API — `kanbo serve`

`kanbo serve` serves one board and one workspace over HTTP: a board page for a browser at `/`, and a JSON API under `/issues`. The board and workspace are resolved like every other command (`--db`, `--database-url`, `--workspace`, the environment, the project's binding).

```bash
export KANBO_SERVE_TOKEN="$(openssl rand -hex 16)"   # a secret of your own; do not give it to an agent
kanbo serve                                           # http://127.0.0.1:4318
kanbo serve --port 8080 --workspace acme-api
kanbo serve --host 0.0.0.0 --cors-origin https://board.example.com   # needs the token
```

On start it prints two lines on stderr: the address, the workspace and whether a token is required; then who may act for a person (`a request with the token acts for <user>`, or `no request acts for a person` and why). Stop it with Ctrl-C.

## The board page

Open `http://127.0.0.1:4318/`. It shows the workspace's columns in board order with their cards: key, title, status line, a **Waiting for you** badge, the attempt count and a pulsing dot while a run is going. An empty Canceled column is hidden.

- Drag a card to another column to move it; a refusal by the column's entry rules is shown as the server says it.
- **+ New** at the top of a column creates a card from a description.
- Click a card for its panel: description (plain text), comments and a box to add one, the activity feed, its runs, and **Approve** / **Return** while it waits for a person. Esc closes the panel.
- Type the server token into the **Token** field in the header. It is sent as `Authorization: Bearer …` and kept in the tab's `sessionStorage` only.
- The page polls `GET /issues/version` every two seconds while its tab is visible and reloads when the board changed.

The page, `/assets/board.js` and `/assets/board.css` are served without the token (they hold no data), with `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `x-content-type-options: nosniff`, `referrer-policy: no-referrer` and `cache-control: no-cache`. Card content is inserted as text, never as HTML. If the package was not built, `/` answers `404` with `The board page is not built. Run: npm run build`.

## Security model

Every request passes these checks, in this order, before it is routed:

1. **Loopback by default.** The server binds `127.0.0.1` (`--host ::1` works too). Any other address, `0.0.0.0` included, is refused at start unless a token is set.
2. **Its own name only.** On loopback it answers only a `Host` of `127.0.0.1`, `localhost` or `[::1]` with its port — `403 host_not_allowed` otherwise — which turns away DNS-rebinding pages.
3. **Listed origins only.** A request with an `Origin` header that is neither listed with `--cors-origin` (exact match, repeatable) nor the server's own origin is `403 origin_not_allowed`, whatever its method. A listed origin is echoed in `Access-Control-Allow-Origin`; its preflight (`OPTIONS`) is answered `204` with the allowed methods (`GET, POST, PATCH, DELETE, OPTIONS`) and headers (`authorization, content-type, x-kanbo-actor`). Clients that send no `Origin` (curl, scripts) are unaffected.
4. **The token.** With `--token` or `KANBO_SERVE_TOKEN` set, every request except a preflight and the board page needs `Authorization: Bearer <token>`, compared in constant time; otherwise `401 unauthorized`. Prefer the environment variable: `--token` is visible to other users in `ps`.
5. **JSON for writes.** Anything but `GET`, `HEAD` and `OPTIONS` must send `content-type: application/json` — `415 unsupported_media_type` otherwise.
6. **1 MB body limit.** Larger bodies are `413 payload_too_large`, and the connection is closed.
7. **One request at a time.** Requests are handled in arrival order.

Nothing secret is logged: never a token, a header or a connection string.

## Who a request writes as

Every write is filed as `external`, under `KANBO_ACTOR_ID` or the user who started the server — the same actor the `kanbo` command writes as.

Approving, returning, closing a sprint, setting a column's entry rules, deleting a comment the board wrote, removing a pull request link somebody else made and deleting a card are a person's. A request acts for the person who started the server only when **all** of these hold:

- the server has a token and the request presented it;
- the server was not started from an agent's shell (`KANBO_ACTOR_KIND=agent`);
- the request did not send `x-kanbo-actor: agent` (any comma-separated value `agent`, any case). No header value can *raise* a request.

Otherwise those operations answer `403` (`issue_approval_requires_user`, `issue_return_requires_user`, `issue_sprint_close_requires_user`, `issue_column_rules_requires_user`, `issue_comment_delete_requires_user`, `issue_pull_request_not_yours`, `issue_delete_requires_user`). A person's card placements into a column whose entry rules are unmet succeed and carry `unmetRules`; anyone else's are refused.

An agent that talks to the server should send `x-kanbo-actor: agent` and should not be given the token.

## Errors

Failures are JSON: `{ "code": "…", "message": "…", "details": { … } }`. A body, query or path of the wrong shape is `400 validation_error` with `details: { source, issues: [{ path, message }] }`. An unknown path is `404 not_found`. An unexpected failure is `500 internal_server_error`.

## Routes

All routes are under `/issues`. A card is addressed by its key (`API-001`). A `workspaceId` other than the served workspace is `404 issue_workspace_not_found`; with no `workspaceId`, list routes answer for the served workspace.

| Method and path | Does |
| --- | --- |
| `GET /issues` | List cards. Query: `workspaceId`, `workspaceIds`, `milestoneId`, `parentIssueId`, `priority`, `labels`, `statusId`. |
| `POST /issues` | Create a card. |
| `GET /issues/:id` | Read a card. |
| `PATCH /issues/:id` | Update a card. |
| `DELETE /issues/:id` | Delete a card (person only). |
| `GET /issues/search` | Search cards by key, number, title or description. Query: `q`, `limit` (default 20). |
| `PATCH /issues/bulk` | Apply one change to many cards. |
| `POST /issues/reorder` | Persist the order of cards after a drop. |
| `PATCH /issues/:id/status/:statusName` | Move a card to a column. |
| `PATCH /issues/:id/status-line` | Set the status line. |
| `POST /issues/:id/wait-approval` | Hand the card to a person. |
| `POST /issues/:id/approve` | Approve (person only). |
| `POST /issues/:id/return` | Return a card with a reason (person only). |
| `GET /issues/:id/comments` · `POST /issues/:id/comments` | List and add comments. |
| `DELETE /issues/comments/:id` | Delete a comment. |
| `GET /issues/:id/activity` | The activity feed. |
| `GET /issues/:id/field-changes` | The raw field history. |
| `GET /issues/:id/relations` · `POST /issues/relations` · `DELETE /issues/relations/:id` | Relations between cards. |
| `POST /issues/:id/context-refs` · `DELETE /issues/:id/context-refs/:index` | A card's context references. |
| `GET /issues/:id/pull-requests` · `POST /issues/:id/pull-requests` · `DELETE /issues/:id/pull-requests/:linkId` | Linked pull requests, with their standing as the card's recorded facts say. Nothing is asked of GitHub. |
| `GET /issues/:id/runs` · `POST /issues/:id/runs` | List and start runs. |
| `PATCH /issues/runs/:runId` | Finish a run or attach what it ran in. |
| `GET /issues/statuses` · `POST /issues/statuses` | List and create columns. |
| `PATCH /issues/statuses/:id` · `DELETE /issues/statuses/:id` | Update (name, description, entry rules) and delete a column. |
| `POST /issues/statuses/reorder` | Reorder columns. |
| `POST /issues/statuses/standard` | Add the missing standard columns. |
| `GET /issues/columns` | Columns of the workspaces in `workspaceIds`. |
| `GET /issues/milestones` · `POST /issues/milestones` | List and create milestones. |
| `PATCH /issues/milestones/:id` · `DELETE /issues/milestones/:id` | Update and delete a milestone. |
| `POST /issues/milestones/:id/close` | Close a sprint (person only). |
| `GET /issues/sprints` | Milestones read as sprints. |
| `GET /issues/version` | The board's change counter, `{ "seq": n }`. Poll it; there is no push. |
| `GET /issues/ready` | Cards ready to pick up. |
| `GET /issues/prime` | The prime text. |

The request bodies are the zod schemas in `src/serve/schemas.ts`, and the response shapes the views in `src/serve/views.ts`.

### Example

```bash
T="$KANBO_SERVE_TOKEN"
curl -s -H "authorization: Bearer $T" http://127.0.0.1:4318/issues/version
curl -s -H "authorization: Bearer $T" -H 'content-type: application/json' \
     -X PATCH http://127.0.0.1:4318/issues/API-001/status-line \
     -d '{"statusLine":"Running the test suite"}'
```

## What it does not do

It launches and stops no agent, keeps no chat sessions, and serves one workspace — there is no project switcher. An app that launches agents can serve the same routes itself and add those.
