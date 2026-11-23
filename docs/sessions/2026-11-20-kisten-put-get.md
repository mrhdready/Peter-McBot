# 2026-11-20: Kisten – Chatbefehle `put` und `get`

**Anlass:** Seit der Bot sein Inventar kennt, soll er Dinge in Kisten ablegen und aus Kisten holen.

**Protokoll (live mit `scripts/smoke-chest.cjs` geprüft)**
- Der Klick auf die Kiste ist dasselbe `inventory_transaction` (item_use/click_block) wie bei Türen. Der Server verarbeitet ihn erst zusammen mit einem folgenden `player_auth_input`. Ein stehender Bot sendet keine Eingaben, deshalb blieb der erste Versuch ohne Antwort.
- `container_open` kommt mit window_type `container`. Eine Doppelkiste ist ein Fenster mit 54 Slots. Beim Öffnen schickt der Server das Bot-Inventar mit neuen Stack-IDs.
- In `item_stack_request` heißt die Kiste `container`; `level_entity` lehnt der Server mit Status 50 ab. Eine einzelne `place`-Aktion bewegt Items direkt in beide Richtungen.

**Änderungen**
- `world.ts`: `searchBlocks` akzeptiert eine Liste von Block-IDs; neu ist `blockRuntimeIdAt`.
- `inventory.ts`: `place` (eine Aktion, liefert die Serverantwort), `ContainerWindow` für die offene Kiste, `nextTransfer` (Zug-Planung mit Stapelgröße aus prismarine-registry), rohe Items je Slot fürs Handitem.
- `navigation.ts`: Die Klick-Logik der Türen ist jetzt `clickBlock` und wird mitgenutzt.
- `bot.ts`: `useChest(chest, planner)` als Job im 20-Hz-Takt (Klick → Öffnen → Inhalt → Züge → Schließen); `cancelChest` bei Navigation/Stopp.
- `chat-commands.ts`: `put <Item>|all [n]`, `get <Item> [n]`, Kistengang über bis zu 5 Kisten mit Zwischenmeldungen.

**Entscheidungen (Grill-Session)**
- Kistenarten: Truhe, Redstone-Truhe, alle Kupfertruhen. Keine Endertruhe, kein Fass, keine Shulker-Kiste.
- Suche ab Bot-Position. `put` füllt zuerst angebrochene Stapel auf, `get` nimmt in Slot-Reihenfolge.
- Höchstens 5 geöffnete Kisten. Unerreichbare Kisten zählen nicht.
- Der Bot behält geholte Items und bleibt an der letzten Kiste stehen. Kisteninhalte werden nicht gespeichert. Nur Chat, keine UI.

**Offen:** `pnpm test` und der Live-Test `SMOKE_MODE=commands` laufen auf der Umgebung des Users; lokal gibt es kein Node.
