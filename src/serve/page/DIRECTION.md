# kanbo board page — design direction

The source of truth for how the board page looks and moves. Edit this first, then `board.css`.
Mockup: `/tmp/kanbo-mockup/index.html` + `board.css` (its tokens layer is the one to copy).
Status: approved by the owner on 2026-11-03 (see the last line); built in plan 006.

## 1. Core idea

Candidates, all from kanbo's own world (agents ask, a person clears):

1. **Controller's strip board.** Each card is a flight-progress strip in its holder: a coloured edge says its state, the key reads like a callsign, columns are bays on a board. The controller (you) clears what is asked.
2. **Kitchen ticket rail.** Tickets clipped to a rail, "order up" when a dish waits for the chef's check before it goes out.
3. **Proof desk.** Galley proofs with pencil marks; old text struck through, new text written in, a sign-off at the end.

**Pick: 1, the strip board.** kanbo's central ritual is an agent asking and a person clearing, and a strip board is built for exactly that: you read the state of every item from across the room, for hours, without excitement. From 3 we borrow one thing: the history reads like proof marks (old value struck through → new value).

## 2. Motion character

**Instrument** — crisp micro-interactions that confirm an action or show a change. A working tool open all day must never move for its own sake; it moves only to say "done", "this changed" or "you're needed".

## 3. Layout

App-like single screen, one CSS grid on `#app` (no new wrappers):

| Row | Element | Notes |
|---|---|---|
| 1 | `.topbar` | wordmark · project switcher · "where" line · token form. Spans every column. Phone: wraps to three rows; once a kept token has loaded the board, the token form folds into a small "Token" button that reveals it (`.topbar[data-token="folded"]`), and a refused token unfolds it by itself. |
| 2 | `.notice` | collapses when hidden |
| 3 | `.filter-bar` | one row that wraps on desktop; on phone one sideways-scrolling row with search, "Showing N of M" and Clear first |
| 4 | `.board` | columns side by side, the board scrolls sideways; each column's card list scrolls on its own, the column head stays put. Phone: columns 86 % wide with scroll snap so the next one peeks. |
| 2–4 | `.panel-host` | ≥ 56.25rem (900 px): a second grid column `--panel-width` (25rem) — the board narrows, nothing is covered. Below: the panel overlays rows 2–4 over a scrim, top bar still in reach; full width on a phone. `:empty` → `display: none`. |

Columns: `flex: 1 0 15rem; max-width: 20rem`. At 1440 px with the panel open four bays fit and the fifth peeks (shows that the board scrolls).

Breakpoints, the only two (mobile first, `min-width`): **40rem** (640 px) and **56.25rem** (900 px). Other `@media` allowed: `prefers-color-scheme`, `prefers-reduced-motion`.

## 4. Palette

Light is a paper strip board in daylight (warm off-white ground, recessed grey bays, white strips, blue-black ink). Dark is the same board under a desk lamp (ink ground, darker bays, raised strips). No brand accent: colour is spent only on state.

The colour language, four words: **orange = you're needed** (only that), **blue = a machine at work** (a run, an agent), **ink = you**, **grey = kanbo itself**. Green says done, red says something failed.

| Token | Job | Light | Dark |
|---|---|---|---|
| `--color-bg` | the board's ground | `#F1EFE9` | `#13161A` |
| `--color-surface` | top bar, filter bar, panel | `#FAF9F6` | `#181C21` |
| `--color-well` | a column's bay | `#E6E3DB` | `#0E1013` |
| `--color-raised` | cards, fields | `#FFFFFF` | `#1F242B` |
| `--color-text` | text | `#1B2129` | `#E6E8EB` |
| `--color-text-muted` | secondary text | `#59616C` | `#9AA2AD` |
| `--color-border` | hairlines that only separate | `#DCD8CF` | `#2B3139` |
| `--color-border-strong` | edges that identify a control | `#8A867D` | `#6B7480` |
| `--color-focus` | focus ring | `#1B2129` | `#E6E8EB` |
| `--color-primary` / `--color-on-primary` | Approve, pressed toggles, Urgent | `#1B2129` / `#FFFFFF` | `#E6E8EB` / `#13161A` |
| `--color-waiting` / `--color-on-waiting` | **waiting for you** — the one loud colour | `#E8590C` / `#1C0D02` | `#FF8A3D` / `#1C0D02` |
| `--color-waiting-wash` | a waiting card, the Decision block | `#FFF1E5` | `#2E2119` |
| `--color-running` (= `--color-agent`) | run dot, "Running", agent chips | `#1E5BC6` | `#7AA7FF` |
| `--color-running-wash` (= `--color-agent-wash`) | agent chip fill | `#E7EEFB` | `#1B2740` |
| `--color-done` | Done edge, finished run | `#2C7A4B` | `#5DC58A` |
| `--color-quiet` | canceled edge, kanbo's hollow dot | `#8B9098` | `#727B86` |
| `--color-danger` / `--color-danger-wash` | errors, failed run | `#BF2A2A` / `#FCEBEA` | `#FF6F6A` / `#3A1D1D` |
| `--color-tint` | label chips, hover | ink 6 % | text 8 % |
| `--color-scrim`, `--color-shadow`, `--color-shadow-strong` | overlay and depth | ink 28 / 7 / 14 % | black 50 / 30 / 45 % |

**The waiting colour is used for nothing else**: the waiting badge, a waiting card's edge, ring and wash, the Decision block while the card waits, and the small square on the "Waiting for you" filter. Urgent priority is ink, not orange; errors are red, not orange.

Measured contrast (WCAG 2.x, script `/tmp/kanbo-qa/contrast.mjs`). Text needs 4.5:1, meaningful edges/chips 3:1. All pass.

| Pair | Light | Dark |
|---|---|---|
| text on bg / raised / well / waiting-wash | 14.09 / 16.20 / 12.63 / 14.63 | 14.78 / 12.71 / 15.52 / 12.69 |
| muted on surface / raised / well / waiting-wash | 5.95 / 6.27 / 4.89 / 5.66 | 6.64 / 6.05 / 7.39 / 6.04 |
| on-primary on primary | 16.20 | 14.78 |
| on-waiting on waiting (badge text) | 5.29 | 8.08 |
| waiting on raised / waiting-wash / surface (edge, badge shape) | 3.58 / 3.23 / 3.40 | 6.66 / 6.64 / 7.30 |
| running on raised / running-wash (text) | 6.24 / 5.35 | 6.54 / 6.24 |
| done on raised (edge) / on surface (text) | 5.26 / 5.00 | 7.30 / 8.00 |
| quiet on raised / surface (edge, dot) | 3.21 / 3.05 | 3.64 / 3.99 |
| danger on surface / danger-wash (text) | 5.57 / 5.09 | 6.30 / 5.63 |
| border-strong on raised / surface (control edges) | 3.63 / 3.45 | 3.30 / 3.61 |
| focus on bg / well / surface | 14.09 / 12.63 / 15.39 | 14.78 / 15.52 / 13.94 |

Tightest margins: light muted-on-well 4.89, light quiet-on-surface 3.05, light waiting-on-wash 3.23. Re-measure if any of these move.

## 5. Type

- **Text:** system UI stack `system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif` — readable, zero bytes, it is a working tool.
- **Mono** for keys, times, counts, the "where" line, branch names: `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace`, always `tabular-nums`.
- **Display** (`--font-display`; used only for the wordmark, column names, panel title, panel section headings) — the owner chooses:
  - **(a) none — recommended.** `--font-display: var(--font-text)`. Hierarchy from weight, size and caps: column names and section headings 0.75rem / 700 / uppercase / 0.06em tracking ("bay labels"), panel title 1.25rem / 650. Cost: 0 bytes, no CSP change.
  - **(b) Big Shoulders** (Patric King, SIL Open Font License — `license: "OFL"` in google/fonts `ofl/bigshoulders/METADATA.pb`), variable (axes `opsz` 10–72, `wght` 100–900). Latin woff2 as Google Fonts serves it: **36 480 bytes** (budget 40 960). A condensed face drawn after Chicago's signage: column names read like bay signs. Needs `font-src 'self'`, one route, the licence file (plan step 4). Preview: `shots/1440x900-light-font-b.png`; sizes under `.font-b` in the mockup CSS (column names and section heads 0.875rem / 750, wordmark 1.25rem / 800).
- **Scale** (6 steps): `--text-xs` 0.6875rem (keys, times, chips) · `--text-sm` 0.75rem (status line, badges, buttons, labels) · `--text-base` 0.8125rem (body, facts, history) · `--text-md` 0.875rem (card titles, description, fields) · `--text-lg` 1rem (wordmark) · `--text-xl` 1.25rem (panel title). Leading `--leading-tight` 1.3, `--leading-normal` 1.5. Never `px` for `font-size`.
- Weights: 400 body, 500 controls, 600 card titles and values, 650–700 headings and badges. Headings `text-wrap: balance`, body `pretty`; `-webkit-font-smoothing: antialiased` on body.

## 6. Spacing & shape

- **Space** (4 px base, 7 steps): `--space-1` 0.25rem · `-2` 0.5rem · `-3` 0.75rem · `-4` 1rem · `-5` 1.5rem · `-6` 2rem · `-7` 3rem.
- **Radii** (3): `--radius-sm` 0.1875rem (chips, badges) · `--radius-md` 0.375rem (cards, buttons, fields) · `--radius-lg` 0.625rem (bays = md + the bay's 4 px padding, concentric).
- **Strip edge:** `--edge-width` 3px, drawn as `inset` box-shadow so it follows the card's corner.
- **Shadows** (3): `--shadow-card` (1 px paper thickness) · `--shadow-lift` (the open card) · `--shadow-panel` (overlay panel only; the docked panel has a hairline instead).
- **Z-layers:** `--z-raised` 1 (sticky panel head) · `--z-panel` 10 · `--z-overlay` 20 · `--z-toast` 30. No numeric `z-index` outside tokens.
- **Sizes:** `--control-height` 2.5rem below 40rem (touch), 1.875rem above; `--chip-height` 2.5rem / 1.5rem; `--column-width` 15rem; `--column-max` 20rem; `--panel-width` 25rem.
- **Card anatomy, top to bottom** (the required reading order): state row (Waiting badge, or run dot + "Running · agent"; attempt `×N` at the right) → title (600, 3 lines max with ellipsis) → key + worker chip (agent: blue square; You: ink circle; Nobody: nothing; not repeated while running) → status line (muted, rule on the left, 2 lines max) → priority + labels (Urgent ink-filled, High ink outline, Medium/Low grey outline, None hidden; labels on a light tint).
- Focus: `:focus-visible` ring 2 px `--color-focus`, offset 2 px; on a card the ring is drawn by the title's stretched `::after`. The open card has a flush 2 px ink ring + `--shadow-lift`, so "open" and "focused" never look the same.

## 7. Motion tokens and rules

Tokens: `--duration-fast` 120ms · `--duration-base` 200ms · `--duration-slow` 320ms · `--duration-loop` 1600ms (the run dot and the one waiting call — a token so no literal sits outside `:root`) · `--ease-out` `cubic-bezier(0.2, 0, 0, 1)` · `--ease-in-out` `cubic-bezier(0.45, 0, 0.55, 1)` · `--press-scale` 0.96.

What moves — only this:

| What | How | Why |
|---|---|---|
| Panel, first opening only (`.panel--opening` when `renderPanelHost` sees `opening === true`) | fade + 1.5rem slide from the right, slow, ease-out | shows where the card went |
| A card new or changed column since the last render (`data-enter="new"` / `"moved"`) | fade + 4 px lift, base, ease-out, once | shows what changed while you looked away |
| Drop target column (`.drop-target`) | bay lightens, 2 px strong inset ring, fast | confirms where the card will land |
| Buttons, toggles, chips on press | `scale(0.96)`, fast; colour change fast | confirms the press |
| Run dot | a ping ring grows and fades, loop, in-out; the dot itself stays solid | a machine is working right now |
| Waiting badge, once, when a card starts waiting (`data-enter="waiting"` on the badge) | one orange ring grows to 0.5rem and fades, loop duration, one iteration | you're needed, said once |

Rules:
- Nothing animates on an ordinary poll refresh. The first render after load animates nothing (`lastPlacement` empty). The step 5 helper decides `new` / `moved` from previous and next placements; the waiting call needs the same bookkeeping for `waitingFor` (previous render not waiting → now waiting).
- Hover is colour only (card ring → border-strong), never movement. No `transition: all`; list the properties.
- `prefers-reduced-motion: reduce` → the duration tokens become 0ms and `--press-scale` 1 in a third `:root` block, and every keyframe sits inside `@media (prefers-reduced-motion: no-preference)`. Final states only; the run dot is a still dot and "Running" still says it in words. Checked in the mockup: 5 running animations with no preference, 0 with `reduce`.
- Motion is never the only signal: every animated state also has a static cue (badge, edge colour, words).

## 8. Anti-sameness

Three things that make this kanbo and not a generic kanban template:

1. **The strip edge.** Every card carries a 3 px state edge (orange / blue / green / grey) like a strip in its holder, and waiting strips are washed warm. The board reads as colour bands from across the room, not a grid of identical white tiles with tags.
2. **A four-word colour language and no brand accent.** Orange = you're needed, blue = a machine at work, ink = you, grey = kanbo. Approve is plain ink, not a brand colour; Urgent is ink, not red. Nothing is coloured for decoration.
3. **Paper and ink, with callsigns and proof marks.** A warm paper ground with recessed bays instead of the cool grey or near-black SaaS ground; keys, times and counts in mono like callsigns; the history as proof marks — old value struck through → new value in weight, on a ruled timeline with a dot per actor (blue square-ish agent, ink you, hollow grey kanbo).

Not used, and why: **custom cursor** — no (a tool; the system cursor is the right one); **smooth-scroll library** — no (dependency, and native scroll is what a board needs); **preloader** — no (the page is two small files); **glass cards** — no (blur costs paint on every poll and fights readability); **blur-in headings** — no (headings never animate in a tool).

## Builder notes

What today's page code (plus plans 002–005) must add so the CSS can do this — classes and `data-*` only:

- `.card[data-state]`: `waiting` if `waitingFor === 'human'`; else `running` if `activeRun?.state === 'running'`; else `done` if the column's category is `completed`; `quiet` if `canceled`; else `idle`. `.card[data-open]` on the card whose panel is open.
- Card order (state row first) can be done with CSS `order` / `display: contents` on today's `.card-head` / `.card-status`, or by moving elements in `card-element.ts`.
- **Not in today's card DOM** (confirm scope before building): the visible words "Running · claude" (today the dot only has a title), the priority chip and labels on a card. If they stay out of scope, the running state is the blue edge + dot + the worker chip in blue.
- Filter bar (plan 004): `.filter-search`, `.toggle[data-filter="waiting|running"]`, `.chip[data-group="priority|label"][aria-pressed]`, `.filter-count`, `.filter-clear`; selects wrapped in `.select-wrap` (chevron from `::after`). Groups are spaced by sibling selectors — no wrappers needed.
- Top bar (plan 002): `.project-switcher.select-wrap`, `.where` with `.where-key`.
- Panel (plan 005): `.facts` (the `<dl>`), `.panel-section[data-waiting]` on Decision while the card waits, `.history-day`, `.history-list`, `.history-entry[data-kind]`, `.history-what`, `.history-field`, `.history-time`, `.history-change`, `.value-from` (`<del>`), `.value-to` (`<ins>`; the arrow is `.value-from + .value-to::before`), `.history-text` (`<details>`) with `.history-text-block[data-side="before|after"]`, `.actor-chip[data-kind]`, `.actor-label`.
- Run list: `[data-run-state="finished|failed|…"]`.

## Mockup

- `/tmp/kanbo-mockup/index.html`, `/tmp/kanbo-mockup/board.css` (no JS; dark mode follows the system setting; `fonts/` holds only the option (b) preview face).
- Content: project weather-station (WST), 13 of 16 cards shown (label filter firmware / sensors / dashboard), five columns, two waiting, two running, attempts ×3 and ×2, Urgent and High, a 3-line-clamped title; WST-09 open with facts, Decision, comments, History over three days and one before/after.
- Shots (`/tmp/kanbo-mockup/shots/`), headless Chrome (1440 at 1×, 390 at 2×): `1440x900-light.png`, `1440x900-dark.png`, `390x844-light.png`, `390x844-dark.png` (required); extras: `1440x900-{light,dark}-history.png` (panel scrolled to History), `390x844-{light,dark}-board.png` (phone, panel closed), `1440x900-light-font-b.png` (option b).

---

Approved by the owner on 2026-11-03. Type: option (a), the system font stack; no web font.
