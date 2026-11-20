# Architektur und Schnittstellen

## Module

`bot.ts` verarbeitet Befehle im zentralen 20-Hz-Takt. `state.ts` und `world.ts` verwalten Position, Dimension, Chunks und Abdeckung. `chunk-worker.ts` decodiert Blockdaten außerhalb der Hauptschleife. `web.ts` stellt HTTP und SSE bereit und liefert das Webinterface aus. Dessen Quellen liegen in `src/ui/` (`index.html`, `style.css`, `app.js`); `pnpm build` kopiert sie nach `dist/ui/`, `web.ts` liest sie einmal beim Start und bettet Stil und Skript inline ein (CSP erlaubt nur Inline-Code, ein Frontend-Build entfällt). `map-archive.ts` persistiert Oberflächenkacheln, `places.ts` gespeicherte Orte und den Navigationsverlauf, `skin.ts` den eigenen Skin, `map-performance.ts` liefert den zuschaltbaren Messmodus und Laufzeitzähler. `healthcheck.ts` prüft den HTTP-Prozess mit dem schlanken Standard-HTTP-Client.

`pathfinder.ts` enthält den gemeinsamen portionsweisen A*-Planner für Vorschau und Navigation. `terrain.ts` prüft Kollisionsformen, Kopffreiheit und Landeflächen. `navigation.ts` setzt die Bewegung in Protokolleingaben um. Die Vorschau verändert weder Position noch aktive Navigation und sendet keine Bewegungspakete.

Planung: maximal 16384 Suchknoten, je Aufruf höchstens 128 Knoten mit einem weichen Zeitbudget von vier Millisekunden. Vorschauen enden nach spätestens 15 Sekunden; Navigation hat ein Zeitlimit und begrenzte Neuplanung. Diese Grenzen sind keine harte Echtzeitgarantie.

Der Planer sucht den am sichersten zu bewältigenden, nicht den kürzesten Weg. Kosten je Schritt: flach 1, Halbstufe oder Treppe 1,5, Abstieg 4, Sprung 5; ein Feld neben einem Abgrund, einem Loch von mindestens etwa einem Block oder unbekannten Daten kostet zusätzlich 2. Ein einzelnes Loch wird dadurch umgangen; ein unvermeidbarer Sprung bleibt möglich. Die Konstanten stehen in `pathfinder.ts`.

Während der Navigation werden kleine Serverkorrekturen (höchstens 0,5 Block neben dem aktuellen Wegabschnitt, höchstens 0,1 Block Höhenabweichung, auf festem Boden) ohne Neuplanung übernommen. Nach mehr als drei Neuplanungen ohne erreichten Wegpunkt bricht die Navigation ab; jeder erreichte Wegpunkt setzt diesen Zähler zurück. Sind die Weltdaten am nächsten Wegpunkt unbekannt, bleibt der Bot bis zu drei Sekunden stehen und plant erst danach neu. Neuplanungen, Korrekturen und Abbrüche erscheinen im Prozesslog mit dem Präfix `[nav]`.

## Weltmodell und Karte

Der Cache hält einen Kreisradius von vier bis sechs Chunks. Beim Standardradius vier sind das 49 Spalten beziehungsweise 1176 Subchunks in der Overworld. Fehlende Spalten werden ausdrücklich angefordert, auch ohne neue Serverankündigung. Fehlgeschlagene Abschnittsanfragen werden begrenzt und zeitlich gestaffelt wiederholt. Unbekannte Daten gelten nicht als Luft.

Die Draufsicht zeigt höchste bekannte Blöcke, keine verbindliche Navigationshöhe. Bot (🤖), Ziel (📌) und gespeicherte Orte (📍) erscheinen als Pins, Suchtreffer als türkise Punkte. Andere Spieler in Reichweite des Bots erscheinen als Tierkopf im runden Chip; das Tier ergibt sich aus einem Hash des Gamertags und bleibt so pro Spieler gleich. Hover beziehungsweise erstes Tippen zeigt Name, X/Y/Z und Entfernung zum Bot. Der Server meldet nur Spieler in der Nähe (`add_player`, `move_player`, `move_entity_delta`, `remove_entity` mit der Unique-ID, `player_list` beim Verlassen des Servers); wer die Reichweite verlässt oder sich abmeldet, verschwindet sofort. Spielerpositionen werden weder gespeichert noch protokolliert. Eine dünne dunkle Linie mit abgerundeten Ecken zeigt gestrichelt die Vorschau und durchgezogen den Restweg. Neue Weltdaten, Chunkwechsel und Ankunft aktualisieren die Karte; unveränderte Daten werden periodisch geprüft. SSE aktualisiert den Status ungefähr jede Sekunde.

Das Gelände wird kachelweise als Pixelpuffer gerastert; Blockfarben und Raster werden wiederverwendet. Cursor, Bot und Route liegen auf einer separaten Ebene, Mausereignisse werden über `requestAnimationFrame` gebündelt. Leichter heller Nebel markiert historische Daten. Der Ausschnitt reicht von standardmäßig 112 × 112 bis maximal 448 × 448 Blöcke. Große Ausschnitte verwenden begrenzte Teilabfragen; die gesamte Welt wird nicht in den Browser geladen.

## HTTP-API

- `GET /healthz`: Zustand des Webprozesses, kein Nachweis einer Minecraft-Verbindung.
- `GET /api/status`, `GET /api/events`: Snapshot beziehungsweise SSE mit Position, Navigation, Abdeckung und `players: [{id, name, x, y, z}]` (andere Spieler in Reichweite) und `roster: [{name, position}]` (alle Spieler auf dem Server außer dem Bot; `position` ist `null` außerhalb der Reichweite).
- `GET /api/map`: bisheriger unpersistierter Live-Ausschnitt; `GET /api/block-ids`: Registry-IDs.
- `GET /api/map/tiles?dimension=0&x=-4&z=-4&width=8&height=8`: Manifest mit Koordinaten, SHA-256 und `empty`-Markierung; X/Z sind Chunkkoordinaten, maximal 8 × 8 Kacheln pro Anfrage.
- `GET /api/map/tile?dimension=0&x=-1&z=-2`: einzelne Oberflächenkachel mit Live-Markierungen und ETag; bedingte Anfragen ermöglichen HTTP 304.
- `GET /api/map-performance`: Node- und cgroup-Zähler; `/?measure=1`: Oberfläche mit zuschaltbarer Messung.
- `GET /api/blocks?block=minecraft:diamond_ore&limit=50`: bis zu 100 nächste Treffer.
- `POST /api/preview`: JSON `{"x": 10, "z": -20}`; ausschließlich Planung ohne Bewegung.
- `POST /api/navigate`: dasselbe X/Z-Format; HTTP 202 bedeutet eingereiht, nicht angekommen.
- `POST /api/connect`, `/api/disconnect`, `/api/stop_navigation`: ohne Body.
- `GET /api/pois?dimension=0`: gespeicherte Orte und die letzten zehn angenommenen Navigationsziele dieser Dimension sowie die erlaubten Symbole.
- `POST /api/pois`: JSON `{"name": "Basis", "icon": "home", "x": 5, "z": -3, "dimension": 0}`; Name 1–40 Zeichen, höchstens 200 Orte je Dimension (sonst HTTP 409), Body höchstens 512 Byte. Antwort HTTP 201.
- `POST /api/pois/delete`: JSON `{"id": "…"}`; unbekannte IDs ergeben HTTP 404.

- `GET /api/skin`: gespeicherter Skin als normalisiertes 64×64-PNG (HTTP 404 ohne eigenen Skin); ein Query wie `?h=<sha256>` dient nur dem Browser-Cache.
- `POST /api/skin`: JSON `{"png": "<base64>", "model": "classic"}` oder `"slim"`; PNG höchstens 48 KB, nur 64×64 oder 64×32 (64×32 wird wie bei Java auf 64×64 erweitert). Antwort HTTP 201 mit dem Skin-Status.
- `POST /api/skin/delete`: ohne Body; zurück zum Standard-Skin.

Jede Änderung an Orten oder Verlauf erhöht `placesRevision` im SSE-Status; Clients laden die Liste dann neu. Ohne übergebenen `PlaceStore` antworten die Ortsrouten mit HTTP 404.

Der Skin wird nur beim Login gesendet (`skinData` von bedrock-protocol); `main.ts` liest ihn bei jedem Verbinden aus `SkinStore`. Ein Upload gilt deshalb erst ab der nächsten Verbindung. Der SSE-Status enthält `skin: {saved, model, active, error}`; unterscheiden sich `saved` und `active` bei bestehender Verbindung, bietet die Oberfläche „Jetzt neu verbinden“ an (Trennen und Verbinden über die normale Befehlsschlange). Gesendet wird ein klassischer Skin auf der eingebauten Geometrie `geometry.humanoid.custom` beziehungsweise `customSlim`; die `SkinId` enthält den Hash, damit Clients keinen alten Skin aus dem Cache zeigen. Eine unlesbare `data/skin.json` wird gemeldet, nicht überschrieben, und der Bot verbindet mit dem Standard-Skin; erst ein Upload oder Zurücksetzen ersetzt sie. Ohne übergebenen `SkinStore` antworten die Skin-Routen mit HTTP 404 und das Panel bleibt verborgen.

POST-Aufrufe benötigen `Content-Type: application/json`; fremde Browser-Origin-Header werden abgelehnt. Diese Prüfung ersetzt keine Authentifizierung. Zielkörper sind auf 128 Byte und ganzzahlige X/Z-Koordinaten begrenzt. Client-Prognosen werden von bestätigten Serverpositionen unterschieden.

## Lokale Dateien

`data/` enthält lokale Identitäts-/Vertrauensdaten, bewusst erzeugte Testberichte, persistierte Oberflächen unter `data/maps/` und gespeicherte Orte samt Navigationsverlauf unter `data/places/` (eine Datei je Server und `MAP_WORLD_ID`) sowie den eigenen Skin in `data/skin.json` (serverunabhängig). Vollständige Chunks bleiben im Arbeitsspeicher; historische Oberflächen werden niemals als Navigationsgelände verwendet. Serveradresse, `MAP_WORLD_ID` und Dimension trennen die Archive; beim Weltreset muss der Kartenschlüssel geändert werden. Weder Laufzeitdateien noch generierte Deployment-Pakete werden versioniert. Ausgefüllte Konfigurationen bleiben lokal; nur ihre `.example`-Dateien gehören ins Repository.
