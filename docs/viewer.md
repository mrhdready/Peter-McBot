# Live 3D view

Select **3D** above the map. The map remains the default. **Frei** uses mouse dragging to look, WASD to move horizontally, and Q/E to descend/ascend. Focus the canvas before using the keyboard. **Bot-Sicht** follows the bot's eye position and reported/sent orientation. **Zum Bot** returns the free camera to the bot. Camera controls never send movement commands to Minecraft.

The backend remains headless. WebGL is required only in the browser. Loading or rendering failures return to the map. Entities, route overlays and destination selection remain outside the 3D view; use the map for navigation and markers.

## Data and limits

The viewer uses the existing circular `CHUNK_RADIUS` cache (4–6 chunks) in the bot's current dimension. Free camera movement does not request extra chunks. Map zoom and historical surface tiles are independent: archived surfaces cannot reconstruct buildings or caves. Missing sections render without geometry; the status reports how many sections are known. Confirmed air remains distinct from unknown sections in the bot's world model.

`ViewerMapping` converts the Bedrock palette through the installed `minecraft-data` `blocksB2J` table to Java **1.21.4**, matching the assets shipped with `prismarine-viewer` **1.33.0**. This does not change the Bedrock server version. Additional stair-corner states and second-layer water are handled explicitly. Non-air secondary layers without a Java waterlogged equivalent cannot be represented independently. Unknown blocks and unrepresentable states become magenta wool. New Bedrock blocks and some state combinations therefore differ from the game; Java textures, default biome tinting and simplified lighting are used. Bedrock resource packs are not loaded.

Palette creation and chunk conversion run in a dedicated Node worker. A Socket.IO feed on `/api/viewer/socket` sends session resets, position/look updates at up to 10 Hz, column loads/replacements and unloads. Block changes replace affected columns; there is no per-block delta protocol. Converted columns are cached by immutable section references. One column per client awaits acknowledgement, with a 15-second timeout; at most four 3D clients connect. Slow clients cannot create an unbounded chunk queue. Switching back closes the socket and disposes the rendering loop, mesh workers and WebGL resources. The conversion worker stops when the last viewer disconnects.

## Build and deployment

`pnpm build` compiles TypeScript, copies the existing UI and runs `scripts/build-viewer.cjs`. It bundles the viewer and mesher with only the required Java palette, copies the matching atlas/models, and generates gzip variants. All assets are served locally from an explicit `/viewer/` allowlist. There is no CDN or separate listening port. Docker runs the same build. Dependency lifecycle scripts remain disabled.

The maintained pnpm patch fixes the published viewer's negative-height loops, section indexing and bottom-face culling for Y **-64 through 319**, uses local asset paths, disposes reset meshes, and rejects meshing responses from previous world generations. Keep this patch when updating dependencies. A version upgrade must keep the mapping palette, block assets, browser worker and height handling aligned.

## Verification

`pnpm test` includes palette validity, stairs/water/fallbacks, height extremes, camera axes, the actual bundled mesher, HTTP assets and socket updates/evictions/session resets. Browser verification with synthetic chunks must be distinguished from live-server evidence. A browser without WebGL can verify the map fallback but cannot validate the rendered scene or GPU performance.
