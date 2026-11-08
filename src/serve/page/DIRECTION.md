# kanbo board page — design direction

The source of truth for how the board page looks and moves. Edit this first, then `board.css`.
Direction: **Modular's board**, chosen by the owner on 2026-11-07. It replaces the 2026-11-03 "controller's strip board" (plan 006). Plan 015 builds it.
Reference: Modular's `kanban-surfaces--catalog` and `kanban-columnagents--header-badges` shots, and the token values of its `apps/web/src/styles.css`. A person moving between Modular and `kanbo serve` should see one product.

## 1. Core idea

Quiet, near-white, neutral. Geist type, white cards with a hairline ring, translucent column bays, a 28px toolbar, status-category and priority icons, toned label chips. Nothing is loud except the one thing that needs a person: a card waiting for you.

Colour language, kept from the strip board:

- **amber (`warning`) = you are needed** (waiting for you): the "Waiting for you" pill, the Decision box while a card waits, the started-category icon. Nothing else is amber except priority medium's bars and the started category.
- **blue (`info`) = a machine at work**: the run dot, "Running", agent avatars.
- **ink (`foreground`/`primary`) = you**: Approve, the selected state, the primary button.
- **green (`success`) = done**, **red (`destructive`) = failed or refused**, **grey = kanbo itself and everything quiet**.

The four states a card can be in keep their meaning: waiting (amber), running (blue), done and canceled (title in `text-secondary`, no strike-through), idle.

## 2. Motion

Instrument-like: motion only confirms an action or shows a change. Ease `cubic-bezier(0.22, 1, 0.36, 1)`, durations 120 / 150 / 200 / 300 ms, press scale 0.99. A card new or moved since the last render fades in once; the dialog fades in on its first opening; the selection bar rises in 200 ms; the run dot pings. Nothing animates on an ordinary poll. `prefers-reduced-motion: reduce` makes the durations 0 and the press scale 1, and every keyframe sits inside `prefers-reduced-motion: no-preference`.

## 3. Tokens

Light and dark; dark follows `prefers-color-scheme` (no toggle). ≈ means converted from oklch.

| Token | Light | Dark |
|---|---|---|
| `--color-background` | #fafafa | #191919 |
| `--color-foreground` | #262626 | #f5f5f5 |
| `--color-card` / `--color-popover` | #ffffff | #1d1d1d |
| `--color-primary` / `--color-on-primary` | #262626 / #fafafa | #f5f5f5 / #262626 |
| `--color-fill` (hover, bays at 40%) | rgb(0 0 0 / 4%) | rgb(255 255 255 / 4%) |
| `--color-accent` (hover) | rgb(0 0 0 / 7%) | rgb(255 255 255 / 8%) |
| `--color-text-secondary` | #737373 | #818181 |
| `--color-text-dim` (decoration only) | #a1a1a1 | #404040 |
| `--color-border` | rgb(0 0 0 / 6%) | rgb(255 255 255 / 5%) |
| `--color-border-strong` (the rule on an attached sub-task card) | rgb(0 0 0 / 15%) | rgb(255 255 255 / 15%) |
| `--color-input` | rgb(0 0 0 / 7%) | rgb(255 255 255 / 7%) |
| `--color-ring` (focus) | #a1a1a1 | #737373 |
| `--color-info` / `--color-info-fg` | #2b7fff / #1447e6 | #2b7fff / #51a2ff |
| `--color-success` / `--color-success-fg` | #00bc7d / #007a55 | #00bc7d / #00d492 |
| `--color-warning` / `--color-warning-fg` | #fe9a00 / #bb4d00 | #fe9a00 / #ffb900 |
| `--color-destructive` | #fb2c36 | ≈ #fc4148 |

Washes (tinted backgrounds) are the colour mixed in at 12%.

- **Status-category colours:** triage = info; backlog = text-secondary; unstarted = text-dim; started = warning; completed = success; canceled = text-secondary.
- **Priority:** urgent #ef4444, high #f97316, medium #eab308, low #3b82f6, none #6b7280.
- **Labels:** seven tones (blue, emerald, amber, rose, violet, cyan, slate), chosen by a hash of the label text, so a label keeps its tone. Chip: border tone-500 at 20% (amber 25%), background tone-500 at 10%, text tone-700 (light) / tone-300 (dark).
- **Shadows:** xs `0 1px 2px rgb(0 0 0/.04), 0 0 0 1px rgb(0 0 0/.05)`; sm `0 1px 3px rgb(0 0 0/.08), 0 0 0 1px rgb(0 0 0/.06)`; md `0 4px 16px -2px rgb(0 0 0/.10), 0 2px 4px -1px rgb(0 0 0/.06)`; lg `0 8px 40px -8px rgb(0 0 0/.14), 0 2px 8px -2px rgb(0 0 0/.07)`. Dark raises the opacities and adds `inset 0 1px 0 rgb(255 255 255/.06)`. A card has no shadow, only a 1px inset ring of `border`.
- **Radii:** 4, 6, 8, 10 (card), 14 (column, panels, dialog) px.
- **Space:** 2, 4, 6, 8, 10, 12, 16, 24 px.
- **Layers:** numeric `z-index` only through `--z-*` tokens.

## 4. Type

- **Geist** (variable, upright; latin, latin-ext, cyrillic woff2 files in `fonts/`, SIL OFL 1.1, `LICENSE` beside them; the family is never renamed). `font-feature-settings: 'cv01','cv02','cv03','cv04','calt'`, antialiased. Stack: `'Geist', ui-sans-serif, system-ui, sans-serif`.
- **Mono** stays the system `ui-monospace` stack (as in Modular): keys, the where-line, counts.
- **Sizes** (rem): 0.625 (10) · 0.65625 (10.5) · 0.6875 (11) · 0.75 (12) · 0.8125 (13) · 0.875 (14) · 1.5 (24).
- Weight 500 for titles and names, 600 for section titles. Leading 1.375 on card titles. `tabular-nums` for numbers.

## 5. Icons

Hand-drawn inline SVG built with `document.createElementNS`, `aria-hidden`, drawn in `currentColor`.

- **Status category:** 16-unit box, circle r=6. triage = 2px ring; backlog = dashed ring; unstarted = ring; started = ring with the right half filled; completed = filled disc; canceled = ring with a horizontal bar.
- **Priority:** 1–4 bars, 2 wide with 1.5 gaps, heights 4/6/8/10, bottoms at y=12, corner radius 0.5 (low 1, medium 2, high 3, urgent 4). None is one horizontal line.

## 6. Layout

One grid on `#app`: top bar (48px: wordmark, project switcher, where-line in mono 11px, token form), notice, toolbar (one row, every control 28px), active-filter row (only while filtering), then the board or the list. The dialog is a modal over them.

- **Toolbar:** search (224px, `/` focuses, Esc clears), "N cards" or "N of M"; at the right Filter and Display popovers, the Board / List view switch, and the primary "+ New".
- **Columns:** 320px, radius 14, `fill` at 40%, no border. Header: status icon, name, count badge (`n/limit` with a WIP limit, amber at the limit), a lock for entry rules, "+". A card dragged over a column tints it to `fill` at 80%.
- **Card:** radius 10, padding 10/12, `card` background, 1px inset ring of `border`. Rows: meta (checkbox, key, avatar with run dot) / title 13px/500 / status row (status line, "Waiting for you" pill, ×N) / footer (priority icon and word, up to two labels and "+n"). Hover: ring at foreground 15%. Open or selected: ring primary at 60%, background primary at 4%.
- **Narrow screens** (390px): the toolbar wraps, columns scroll sideways.

## 7. Sub-tasks

A sub-task must never be mistaken for a top-level card, and one waiting for a person is never hidden.

- A **child** is a card whose `parentIssueId` names a card in the loaded board; an **orphan** is one whose parent is not loaded (drawn as its own card).
- **Inside mode (default):** a sub-task is where its column says it is. While it shares its parent's column it is folded into the parent's card as a row in the sub-task block under the footer (28px: status-category icon of the child's column, key, title, and on the right the compact "Waiting" pill, a run dot, or "n/m" when it has its own children); a card folded into that row shows as a row one level deeper, right under it (`data-depth`, stepped in 16px a level). At most five rows then "+N more"; a 4px progress bar and "1/3 done" count all direct children, in any column (canceled left out, done = completed category). In any other column the sub-task is a card of its own with the "Sub-task of KEY" strip. A row drags onto any column. A click on a row opens the child. The parent's "Sub-task waiting for you" pill and run dot speak only for folded cards; a card drawn on its own shows its own.
- **Never hidden:** a waiting child at any depth gives its parent a "Sub-task waiting for you" pill; a running child gives the parent's avatar the run dot.
- **Filters apply to the family:** a parent shows when it or any child matches; children that do not match are drawn at 50% opacity.
- **Cards mode** (Display → "Show sub-tasks as cards", `?subtasks=cards`): every card is in its own column. A child gets a "Sub-task of KEY title" strip as its first row (a button that opens the parent), is inset 12px with a 2px `border-strong` rule on its left; a parent shows only the bar and "x/y done".
- The words are "sub-task" and "x/y done", in step with Modular.

## 8. Anti-sameness

What makes this kanbo and not Modular's copy: the "Waiting for you" pill and the Decision box (a person clears what agents ask), the History as proof marks (old value struck through, new value written in), and the sub-task block that keeps waiting work visible.

## Builder notes

- Class names the unchanged modules rely on: `.history-*`, `.actor-chip`, `.facts`, `.project-switcher`, `.where-key`.
- Dialog: `.panel`, `.panel-head`, `.panel-scroll`, `.panel-section[data-waiting]`.
- Page state in the address: `q`, `who`, `waiting`, `running`, `priority`, `label`, `project`, `view=list`, `subtasks=cards`.

---

Direction replaced on 2026-11-07 by the owner's choice of Modular's look (plan 015). Earlier directions: the strip board, approved 2026-11-03; the dialog, 2026-11-04.
