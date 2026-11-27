# Repository Guidelines

## Project Structure & Architecture

- `src/` contains strict TypeScript. `bot.ts` owns the command queue and central 20-Hz heartbeat; `state.ts` and `world.ts` manage position, chunks, and coverage. `chunk-worker.ts` decodes chunks off the main thread.
- `pathfinder.ts` provides shared planning for previews and navigation. `terrain.ts` handles collisions; `navigation.ts` handles movement. Keep previews free of movement and position changes.
- `web.ts` contains the HTTP/SSE server. The interface lives in `src/ui/` (`index.html`, `style.css`, `app.js`); `pnpm build` copies it to `dist/ui/`, and `web.ts` reads it once at startup and inlines style and script. There is no frontend framework or bundler.
- `test/*.test.cjs` contains tests; `test/fixtures/` holds captured protocol data. `scripts/` contains compatibility, probe, smoke-test, and build helpers. `docs/` contains architecture, compatibility, and publication guidance.
- `patches/` contains required dependency patches. `dist/` and `data/` are generated or local output.

## Build, Test, and Development Commands

Use Node.js 24 and pnpm 11.25.0.

- `pnpm install --frozen-lockfile`: install pinned, patched dependencies.
- `pnpm build`: compile TypeScript into `dist/`.
- `pnpm test`: compile and run the Node.js test suite.
- `pnpm build` followed by `node --test test/web.test.cjs`: run focused tests.
- Copy `.env.example` to `.env`, then run `node --env-file=.env dist/main.js`. `pnpm start` uses existing environment variables; it does not load `.env`.
- `pnpm check:compatibility`: check dependency/protocol compatibility.
- `docker compose pull`, then `docker compose up -d`: fetch and run the GHCR image selected by `BOT_IMAGE` in `.env`.

## Coding Style & Naming

Use two-space indentation, single quotes, camelCase identifiers, PascalCase classes/types, and descriptive kebab-case filenames. Follow existing semicolon usage. No formatter or linter is configured. Keep bot logic separate from HTTP handlers and reuse the shared planner and terrain model.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Name files `<module>.test.cjs` and describe observable behavior in test titles. Add focused regressions for changed behavior, especially unknown chunks, stale responses, cancellation, and preview isolation. No percentage coverage threshold is configured. Distinguish automated fixtures from live-server evidence; movement smoke tests move a real player.

## Commit & Pull Request Guidelines

Git history is unavailable in this checkout, so no historical message convention can be confirmed. Use short, imperative commit subjects. PRs should explain the problem, resulting behavior, validation commands, and remaining limits. Link relevant issues and include screenshots for interface changes.

## Security & Configuration

Keep `.env`, filled `config/*.env`, identities, and runtime data local. Version only the corresponding `.example` files. Preserve dependency patches, lockfile consistency, server-key pinning, and signature checks. The unauthenticated interface belongs on a trusted network. Never downgrade the server or world to resolve compatibility issues.
