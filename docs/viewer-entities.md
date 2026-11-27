# Entities im 3D-Viewer – Plan

Stand: 27.11.2026. Ziel: Der 3D-Viewer (`docs/viewer.md`) zeigt den Bot, andere Spieler und später Tiere/Mobs und Items. Die Phasen 2–5 sind nur grob festgehalten; ihre Details werden zu Beginn der jeweiligen Phase geklärt.

## Phasen

| Phase | Inhalt | Status |
|---|---|---|
| P1 | Bot und andere Spieler als Platzhalter mit Namensschild | umgesetzt, Tests grün; Byte-Winkel-Fix für `move_entity_delta` mit P2 |
| P2 | Tiere und Mobs: neues Tracking (`add_entity`, Bewegung, `remove_entity`, Typzuordnung); Smoke-Skript, das die Pakete als JSON-Bericht mitschneidet | umgesetzt (`src/entities.ts`), Tests grün, live bestätigt (Küken klein, `scale` 0.5) |
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
- **Known Issue Blickrichtung:** Einmal zeigte der Viewer den Bot um etwa 180° anders als das Spiel, nach einer Farm-Runde mit Ablage in die Truhe neben dem Bett (Bot-Sicht auf die Truhen, im Spiel abgewandt). Nach `come` und in einem weiteren Test stimmte es. Der Viewer zeigt die zuletzt *gesendete* Drehung; Vermutung: Der Server übernimmt sie in manchen Phasen (Truhe offen?) nicht. Zur Diagnose `VIEWER_DEBUG_YAW=1` setzen (auch über `compose.yaml`): `[nav] yaw sent …` loggt jede gesendete Drehung ab 30° Änderung mit Anlass (`walk`, `look`, `face`, `click`) und Position, `[nav] yaw server move_player …` jede Server-Korrektur des Bots, `[nav] yaw marker container_open/close` die Truhen. Das Log wird nach der Klärung wieder entfernt.
- **Prüfung:** Unit-Tests für State-Tracking, Socket-Event und Rendering-Logik; Live-Check im Browser mit einem zweiten Spieler auf dem Server.

## Entscheidungen P2

- **Ablauf:** Zuerst der Smoke `scripts/smoke-entities.cjs`, danach die Umsetzung auf Basis der echten Pakete. Der Bot steht still und schneidet `SMOKE_WATCH` Sekunden lang mit (Standard 60): `add_entity`, `move_entity_delta`, `move_entity`, `set_entity_motion`, `set_entity_data`, `remove_entity` und `set_entity_link`, aber nichts von Spielern und Items. `SMOKE_ENTITY=<typ>` schränkt auf einen Typ ein. Bericht: `data/entities-smoke-result.json`. Er enthält pro Entity den `add_entity` komplett, bis zu 20 Bewegungspakete und alle `set_entity_data`, dazu pro Typ die Wertebereiche der Drehung und die gesehenen Metadaten-Keys. Für die Gradfrage aus P1 stehen die `rot_*` aus `move_entity_delta` anderer Spieler neben ihrem `move_player`-Yaw. Laut `protocol.json` 1.26.60 sind `rot_*` `u8`, also vermutlich Byte-Winkel (×360/256).
- **Testaufbau:** Pferd und Handelslama, dazu möglichst ein Jungtier (`/summon cow ~ ~ ~ minecraft:entity_born`), ein benanntes Tier und optional ein feindlicher Mob.
- **Daten:** eine neue Map `WorldState.entities` (Runtime-ID → `Entity` aus `src/entities.ts`: `{uniqueId, type, position, yaw, headYaw, pitch, living, name, flags, width?, height?}`). Sie ist generisch für alle `add_entity` und wird in `resetWorld` geleert. `players` und `items` bleiben unverändert. `flags` ist die Menge der gesetzten Flag-Namen aus dem Metadaten-Eintrag `flags`, den bedrock-protocol schon nach Namen entschlüsselt (Baby = `baby`; außerdem `tamed`, `inlove` usw. für einen späteren Züchter-Beruf). `flags_extended` wird nicht nach Namen gelesen, weil minecraft-data 3.119.0 diese Bits um eins verschiebt (siehe `sleepingFlag`). `living` heißt: `add_entity` trägt das Attribut `minecraft:health`.
- **Nutzung:** nur der Viewer. Nicht im SSE-Snapshot, nicht auf der 2D-Karte, nicht in Navigation oder Farming.
- **Typauflösung (`viewerEntity`):** Die Größe kommt aus `boundingbox_width`/`boundingbox_height` der Server-Metadaten, sonst aus minecraft-data, sonst 0,8×0,8. Darauf wird das Metadaten-Feld `scale` angewendet; ohne `scale` werden Babys halbiert. Live gemessen: Ein Küken meldet die Box eines erwachsenen Huhns (0,6×0,8). Die Kategorie stammt aus minecraft-data (für 1.26.60 die Liste aus 1.21.80) plus `CATEGORY_OVERRIDES` (`trader_llama`, `nautilus`: passiv). Gezeichnet werden Passive und Hostile mobs, Vehicles, Boote und Loren sowie Typen ohne Kategorie (fehlend oder `UNKNOWN`, z. B. Dorfbewohner), wenn sie `living` sind. Unbekannte Typen loggt der Server einmal pro Typ (`[viewer] unknown entity type …`), ebenso einmal pro Typ die Bounding Box des ersten Babys (`[viewer] baby …`).
- **Transport:** im volatilen `position`-Paket wie die Spieler, gefiltert auf den Viewer-Radius und höchstens die 128 nächsten. Projektile, XP-Orbs und die Kategorie „Immobile“ filtert schon der Server heraus.
- **Aussehen:** eine Box in Hitbox-Größe, bei Babys halb so groß. Farbe nach Kategorie: passiv grün, feindlich rot, sonst grau. Der Körper dreht sich nach dem Körper-Yaw, Kopfwürfel und Gesichtsmarke nach dem Kopf-Yaw. Ein Namensschild gibt es nur bei eigenem Namen, sonst den Typ als Hover-Tooltip. Die Glättung entspricht P1.
- **Nicht in P2:** Reiten und Leinen (`set_entity_link`, gehört zu P4) sowie alle Flags außer Baby und Name.
- **Prüfung:** Unit-Tests für das Tracking, für Filter und Obergrenze im Stream und für die Rendering-Logik; danach ein Live-Check im Viewer.

### Smoke-Befunde P2 (27.11.2026, 60 s, Pferd, Handelslama, Nautilus, Fledermäuse, Hühner, Kistenboot, Leinenknoten)

- `rot_x`/`rot_y`/`rot_z` in `move_entity_delta` sind rohe Bytes (0–255, ×360/256): Pitch, Körper-Yaw, Kopf-Yaw. P1 hatte `rot_y`/`rot_x` anderer Spieler als Grad übernommen; das ist behoben (`byteAngle`). `add_entity` und das absolute `move_entity` (`byterot`) liefern schon Grad.
- Die Metadaten enthalten `boundingbox_width`/`boundingbox_height` und `scale`. Die Flags kommen als `{ _value, <name>: true … }`; die Bits von `flags` passen zu den Namen (Pferd: `walker`, `tamed`, `leashed`, `breathing`, `has_collision`, `affected_by_gravity`).
- `trader_llama`, `nautilus` und `chest_boat` fehlen in minecraft-data. `remove_entity` kam für entfernte Fledermäuse wie erwartet. `set_entity_motion` und `set_entity_link` kamen nicht vor.
- Nicht abgedeckt: Jungtier, benanntes Tier, feindlicher Mob. Das prüft der Live-Check im Viewer.
- Live-Check 27.11.2026: Mob-Boxen erscheinen. `[viewer] baby chicken bounding box 0.6×0.8` zeigte, dass die Bounding Box bei Babys nicht verkleinert ist. Seitdem wird `scale` angewendet. Der Server schickt für Küken `scale` 0.5, und das Küken erscheint jetzt klein.
