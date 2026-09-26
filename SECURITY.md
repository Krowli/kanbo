# Security Policy

## Supported versions

Only the latest released version of kanbo receives security fixes.

| Version | Supported |
| --- | --- |
| 0.1.x | yes |

## Reporting a vulnerability

Please **do not** report security problems in public issues, discussions or pull requests.

Report them privately through GitHub: open [a private security advisory](https://github.com/Krowli/kanbo/security/advisories/new) ("Report a vulnerability" on the repository's Security tab). Include:

- the kanbo version (`kanbo --version`), Node.js version and operating system;
- which part is affected (CLI, MCP server, `kanbo serve`, Postgres roles, a board file);
- steps to reproduce, and what an attacker could do.

You will get an acknowledgement within a week. Once a fix is ready we publish it with an advisory and credit you, unless you prefer not to be named.

## Scope notes

Things that are by design, not vulnerabilities:

- A board file (`.kanbo/board.db`) is protected only by file permissions; anyone who can write the file can change the board. Use Postgres with the `kanban_agent` role when agents must not be able to approve.
- `KANBO_ACTOR_KIND=agent` is a declaration, not authentication. It protects against an agent using kanbo's own commands to approve its work, not against a process that controls its own environment. Database roles and the `kanbo serve` token are the enforced boundaries.

In scope, for example: `kanbo serve` accepting a request it should refuse (host, origin, token, body limit), a connection string or token appearing in output or logs, the `kanban_agent` role being able to approve, return, or delete a card.
