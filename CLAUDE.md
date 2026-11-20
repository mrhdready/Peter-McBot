# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the contributor guide (structure, style, test and security rules) and applies here too. This file adds the context that takes several files to piece together. The README and `docs/` are in German; `docs/ARCHITEKTUR.md` covers the HTTP API, and `docs/KARTE.md` covers the persistent map.

## What this is

A Minecraft **Bedrock** AFK bot with a local web control panel. It is a single Node.js 24 process, written in strict TypeScript, that connects to an existing server over HTTP-NetherNet (pure-JS WebRTC via `werift`) using an offline identity. It has been verified only against Bedrock 1.26.65 / protocol 2225, with data version `1.26.60`. Other protocol numbers are rejected.

## Commands

Use Node.js 24 (`engines: >=24 <25`) and pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile    # applies patches/ via pnpm-workspace.yaml; install scripts are disabled
pnpm build                        # tsc: src/ -> dist/, then copies src/ui -> dist/ui
pnpm test                         # pnpm build && node --test test/*.test.cjs
pnpm build && node --test test/web.test.cjs                         # one test file
pnpm build && node --test --test-name-pattern "SSE" test/web.test.cjs  # one test by name
node --env-file=.env dist/main.js # run locally; `pnpm start` does NOT load .env
pnpm check:compatibility          # offline; writes ignored compatibility-result.json
```

No linter or formatter is configured; `tsc` is the only static check.

**Tests are CommonJS (`.cjs`) and `require('../dist/...')`**, so they run against compiled output. Always rebuild before running a single test file, or you will be testing stale code.

`scripts/probe-server.cjs` and `scripts/smoke-*.cjs` connect to a **real server**, and the movement smoke tests move a real player. Run them only when the user explicitly asks, with `node --env-file=.env --env-file=config/smoke.env scripts/<name>.cjs`.

## Architecture

**Wiring (`main.ts`).** `main.ts` builds a `BotController` with an injected `ClientFactory` that wraps `bedrock-protocol`'s `createClient`, then creates a `MapArchive` and connects it via `bot.state.onSurfaceTile`. It also starts `createWebServer(bot, archive)` and flushes the archive every 5 s and on SIGINT/SIGTERM. The bot never connects automatically at startup; a `connect` command is required. Tests inject a fake `EventEmitter` client and a controllable `now()` instead of a real connection (see `test/bot.test.cjs`).

**Single-threaded command loop (`bot.ts`).** HTTP handlers never touch the bot directly; they call `bot.enqueue(command)`. The queue holds at most 32 commands, and `stop_navigation` jumps the queue. A 50 ms `setInterval` (`step()`, the 20-Hz heartbeat) drains the queue and handles connection state: wanted/connecting, the login timeout and bounded retry. It also advances navigation and time-sliced preview jobs, and flushes surface changes. Any new long-running work should be a step-able job driven by this tick, not a separate timer.

**World model (`state.ts`, `world.ts`, `chunk-worker.ts`).** `WorldState` owns position, dimension, status and the chunk cache: a circular radius of 4–6 chunks, set by `CHUNK_RADIUS`. Chunk decoding runs in a `worker_threads` Worker loaded from `dist/chunk-worker.js`. Missing columns and subchunks are requested explicitly, with limited retries spread out over time. **Unknown data is never treated as air.** Known and unknown must stay distinguishable everywhere: pathfinding, map rendering and block search. `WorldState.players` holds other players in the server's entity range (from `add_player`, moved by `move_player`/`move_entity_delta`, dropped by `remove_entity` (which carries the unique ID, not the runtime ID), a `player_list` removal (by UUID) and `resetWorld`). It is kept in memory only and exposed as `players` in the snapshot; the UI shows each as a `pin-player` chip with an animal emoji hashed from the gamertag. `WorldState.roster` (UUID → name) holds everyone on the server from `player_list` add/remove records, minus the bot (matched by `start_game.entity_id` or `BOT_NAME`); it is cleared by `resetWorld` and exposed as `roster: [{name, position}]`, where `position` comes from the `players` entry with the same UUID or is `null`. The sidebar's "Spieler" panel lists it.

**Movement (`pathfinder.ts`, `terrain.ts`, `navigation.ts`).**
- `pathfinder.ts` is the one shared incremental A* used by both preview and navigation. Its limits: 16384 nodes, ≤128 nodes per call, a ~4 ms soft budget per call, and a 15 s cap on previews. It optimises for safe handling, not distance: weighted step costs (`COST_*`: flat 1, slab/stair 1.5, drop 4, jump 5, +2 next to a drop/hole/unknown via `Terrain.dropHazard`). Every cost is ≥1, so the Manhattan heuristic stays admissible.
- `navigation.ts` accepts small on-path server corrections without replanning, fails only after more than 3 replans *without waypoint progress*, and waits up to 3 s at an unknown waypoint before replanning. Decisions are logged with the `[nav]` prefix.
- `terrain.ts` answers collision, headroom and landing questions. It handles full blocks, slabs and direction-dependent stairs; steps can go at most 1 block up or 1 block down.
- `navigation.ts` turns a plan into protocol input packets.
- **Preview isolation is a hard invariant:** `/api/preview` must not change position or active navigation, and must not send movement packets. Tests cover this.

**Persistent map (`map-archive.ts`).** Observed *surfaces* (not full chunks) are stored as 16×16 tiles under `data/maps/`. They are keyed by normalized host/port/transport + `MAP_WORLD_ID` + dimension. Writes go to a temp file and are then atomically renamed. Historical tiles are for display only: navigation, preview and block search use **only** the live cache. Merge rules: an incomplete observation never replaces a confirmed surface, while fully known air may replace old blocks. The tile and manifest endpoints use SHA-256 fingerprints and ETags to return 304.

**Web (`web.ts`, `src/ui/`).** `web.ts` holds the `node:http` routes and SSE. The UI lives in `src/ui/index.html`, `style.css` and `app.js`: a map-centred layout with a sidebar, and below 900px a fixed navigation bar. `pnpm build` copies `src/ui` to `dist/ui`; `web.ts` reads the files once at startup and inlines the style and script into the placeholders `<!-- ui:style -->` and `<!-- ui:script -->`. There is no frontend framework or bundler. Tests extract the **single** inline `<script>` and run it against a fake DOM that offers only `getElementById` and `createElement`, so `app.js` must not use `querySelector`, `classList` or other DOM APIs beyond plain property assignment (including `element.style.*`, which the fake elements support). Keep the existing element IDs, because tests address them. Sidebar panels other than "Ziel & Navigation" are native `<details class="panel">` with the `h2` inside `<summary>` (no JS); "Ziel & Navigation" must stay a `<section>` because it contains `#navigate`, the fixed bottom bar below 900px. POSTs require `Content-Type: application/json` and reject foreign `Origin` headers. This is not authentication: the UI is meant for a trusted network only. `createWebServer(bot)` without an archive falls back to the legacy unpersisted `/api/map`.

**Skin (`skin.ts`).** `SkinStore` keeps one custom skin in `data/skin.json` (model and the normalised 64×64 PNG; 64×32 uploads are expanded like Java's legacy conversion). PNGs are decoded with `pngjs`, and the IHDR size is checked before decoding. The skin is sent only in the login chain: the client factory in `main.ts` spreads `skins.connectSkinData()` into `skinData` at every connect, which overrides bedrock-protocol's default persona skin with a classic skin on `geometry.humanoid.custom`/`customSlim`. An upload therefore applies on the next connect. `createWebServer(bot, archive, places, skins)` serves `GET /api/skin`, `POST /api/skin` and `POST /api/skin/delete`, and adds `skin: {saved, model, active, error}` to the SSE snapshot; the UI offers a reconnect when `saved !== active`. An unreadable file is reported and the bot connects with the default skin.

**Map performance (`map-performance.ts`).** This module provides `/?measure=1` and `/api/map-performance`, which report Node and cgroup counters.

**Places (`places.ts`).** `PlaceStore` keeps saved places (POIs) and the last 10 accepted navigation targets per dimension in one JSON file per server/world under `data/places/`, keyed like the map archive. Every operation runs exclusively and commits in memory only after the atomic write succeeds; an unreadable file is reported and never overwritten. `createWebServer(bot, archive, places)` serves `GET /api/pois?dimension=N`, `POST /api/pois` and `POST /api/pois/delete`, records each accepted `/api/navigate`, and adds `placesRevision` to the SSE snapshot so clients refetch. Without a store the UI panel is hidden (`placesEnabled`). In the UI, bot (🤖), target (📌) and places (📍) are DOM pins in `#map-pins` with `pointer-events: none`; the canvas hit-tests them in screen pixels, so dragging and zooming stay on the canvas.

## Dependency patches and trust

`bedrock-protocol@3.61.0` and `prismarine-chunk@1.41.0` are pinned exactly and patched through `patches/`, listed in `pnpm-workspace.yaml`. The patches add NetherNet signalling, signed offline identity, the Bedrock 1.26 chunk loader and the runtime-ID hash fix. Changing those versions means regenerating the patches and keeping the lockfile consistent.

The server operator key is pinned in `data/server-key.sha256`. Do not weaken signature, DTLS or key-pin checks, and never "fix" compatibility by downgrading the server or world.

## Deployment

- `.github/workflows/docker-build.yml` builds the Dockerfile on every push and PR. It publishes to GHCR only on a push to `main`.
- `compose.yaml` pulls `BOT_IMAGE` from `.env`; it has no local build.
- `pnpm prepare:arcane` reads `config/arcane.env` and generates the ignored `deploy/arcane/` from `deploy/arcane-template/`. Edit the template, not the output.
- `test/deployment.test.cjs` checks the deployment configuration.
