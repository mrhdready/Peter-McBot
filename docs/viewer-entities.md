# Entities im 3D-Viewer – Plan

Stand: 27.11.2026. Ziel: Der 3D-Viewer (`docs/viewer.md`) zeigt den Bot, andere Spieler und später Tiere/Mobs und Items. Die Phasen 2–5 sind nur grob festgehalten; ihre Details werden zu Beginn der jeweiligen Phase geklärt.

## Phasen

| Phase | Inhalt | Status |
|---|---|---|
| P1 | Bot und andere Spieler als Platzhalter mit Namensschild | umgesetzt; `pnpm test` und Live-Check offen (u. a. ob `rot_x`/`rot_y` von `move_entity_delta` in Grad ankommen) |
| P2 | Tiere und Mobs: neues Tracking (`add_entity`, Bewegung, `remove_entity`, Typzuordnung); Smoke-Skript, das die Pakete als JSON-Bericht mitschneidet | offen |
| P3 | Items am Boden (`WorldState.items` gibt es schon) | offen |
| P4 | Echte Java-Modelle (Steve/Alex, Mobs), wenn der Jar-Cache (`MINECRAFT_EULA=true`) vorhanden ist; ohne Jar bleiben die Platzhalter. Schleichen und weitere Posen über `set_entity_data`-Flags | offen |
| P5 | Ego-Hand in der Bot-Sicht: Arm aus dem Bot-Skin (`SkinStore`), gehaltenes Item (gewählter Hotbar-Slot + Inventar; Block-Items aus dem Atlas, flache Items aus dem Jar), Schwing-Animation bei Abbauen, Pflanzen, Truhen-/Türklick und Werfen (Ereignisse kommen vom Bot selbst über den Socket) | offen |

## Entscheidungen P1

- **Daten:** `WorldState.players` speichert zusätzlich Yaw und Pitch (Grad, Bedrock) aus `add_player`, `move_player` und `move_entity_delta`.
- **Transport:** die volle Liste (`self`, `players`) reist im volatilen `position`-Paket mit, höchstens 10 Hz, an die Session gebunden. Ursprünglich als eigenes Event geplant; ein zweites volatiles Emit direkt danach verwirft Socket.IO aber, solange der Transport noch schreibt. Yaw/Pitch werden wie die Bot-Pose ins Viewer-Koordinatensystem umgerechnet.
- **Aussehen:** Körper-Box mit Kopfwürfel und heller Gesichtsmarke vorne. Bot in fester Farbe, Spieler in einer aus dem Gamertag gehashten Farbe. Namensschild mit Tier-Emoji wie auf der 2D-Karte (Bot: 🤖).
- **Bot:** in der freien Kamera sichtbar, in der Bot-Sicht ausgeblendet; schläft er, liegt die Box.
- **Glättung:** dieselbe Dämpfung wie die Bot-Sicht (60 ms), Sprünge über 8 Blöcke werden direkt übernommen.
- **Nicht in P1:** Posen anderer Spieler (auch Schlafen), Tiere, Items, Modelle.
- **Offener Punkt Blickrichtung:** Einmal zeigte der Viewer den Bot um etwa 180° anders als das Spiel, nach einer Farm-Runde mit Ablage in die Truhe neben dem Bett (Bot-Sicht auf die Truhen, im Spiel abgewandt). Nach `come` und in einem weiteren Test stimmte es. Der Viewer zeigt die zuletzt *gesendete* Drehung; Vermutung: Der Server übernimmt sie in manchen Phasen (Truhe offen?) nicht. Zur Diagnose `VIEWER_DEBUG_YAW=1` setzen (auch über `compose.yaml`): `[nav] yaw sent …` loggt jede gesendete Drehung ab 30° Änderung mit Anlass (`walk`, `look`, `face`, `click`) und Position, `[nav] yaw server move_player …` jede Server-Korrektur des Bots, `[nav] yaw marker container_open/close` die Truhen. Das Log wird nach der Klärung wieder entfernt.
- **Prüfung:** Unit-Tests für State-Tracking, Socket-Event und Rendering-Logik; Live-Check im Browser mit einem zweiten Spieler auf dem Server.
