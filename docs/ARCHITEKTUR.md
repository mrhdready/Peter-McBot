# Architektur und Schnittstellen

## Module

`bot.ts` verarbeitet Befehle im zentralen 20-Hz-Takt. `state.ts` und `world.ts` verwalten Position, Dimension, Chunks und Abdeckung. `chunk-worker.ts` decodiert Blockdaten außerhalb der Hauptschleife. `web.ts` stellt HTTP, SSE und das Inline-Webinterface bereit.

`pathfinder.ts` enthält den gemeinsamen portionsweisen A*-Planner für Vorschau und Navigation. `terrain.ts` prüft Kollisionsformen, Kopffreiheit und Landeflächen. `navigation.ts` setzt die Bewegung in Protokolleingaben um. Die Vorschau verändert weder Position noch aktive Navigation und sendet keine Bewegungspakete.

Planung: maximal 8192 Suchknoten, je Aufruf höchstens 128 Knoten mit einem weichen Zeitbudget von vier Millisekunden. Vorschauen enden nach spätestens 15 Sekunden; Navigation hat ein Zeitlimit und begrenzte Neuplanung. Diese Grenzen sind keine harte Echtzeitgarantie.

## Weltmodell und Karte

Der Cache hält einen Kreisradius von vier bis sechs Chunks. Beim Standardradius vier sind das 49 Spalten beziehungsweise 1176 Subchunks in der Overworld. Fehlende Spalten werden ausdrücklich angefordert, auch ohne neue Serverankündigung. Fehlgeschlagene Abschnittsanfragen werden begrenzt und zeitlich gestaffelt wiederholt. Unbekannte Daten gelten nicht als Luft.

Die Draufsicht zeigt höchste bekannte Blöcke, keine verbindliche Navigationshöhe. Rot markiert den Bot, Türkis Suchtreffer, Orange das gewählte Ziel und Lila Vorschau oder Restweg. Neue Weltdaten, Chunkwechsel und Ankunft aktualisieren die Karte; unveränderte Daten werden periodisch geprüft. SSE aktualisiert den Status ungefähr jede Sekunde.

## HTTP-API

- `GET /healthz`: Zustand des Webprozesses, kein Nachweis einer Minecraft-Verbindung.
- `GET /api/status`, `GET /api/events`: Snapshot beziehungsweise SSE mit Position, Navigation und Abdeckung.
- `GET /api/map`: Draufsicht bekannter Spalten; `GET /api/block-ids`: Registry-IDs.
- `GET /api/blocks?block=minecraft:diamond_ore&limit=50`: bis zu 100 nächste Treffer.
- `POST /api/preview`: JSON `{"x": 10, "z": -20}`; ausschließlich Planung ohne Bewegung.
- `POST /api/navigate`: dasselbe X/Z-Format; HTTP 202 bedeutet eingereiht, nicht angekommen.
- `POST /api/connect`, `/api/disconnect`, `/api/stop_navigation`: ohne Body.

POST-Aufrufe benötigen `Content-Type: application/json`; fremde Browser-Origin-Header werden abgelehnt. Diese Prüfung ersetzt keine Authentifizierung. Zielkörper sind auf 128 Byte und ganzzahlige X/Z-Koordinaten begrenzt. Client-Prognosen werden von bestätigten Serverpositionen unterschieden.

## Lokale Dateien

`data/` enthält nur lokale Identitäts-/Vertrauensdaten und bewusst erzeugte Testberichte. Weltdaten bleiben im Arbeitsspeicher. Weder Laufzeitdateien noch generierte Deployment-Pakete werden versioniert. Ausgefüllte Konfigurationen bleiben lokal; nur ihre `.example`-Dateien gehören ins Repository.
