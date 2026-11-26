# Schlafsignale am echten Server prüfen

Das Script `scripts/smoke-sleep.cjs` prüft, welche Schlafsignale der konfigurierte Bedrock-Server liefert. Die reguläre [Schlafautomatik](SCHLAFAUTOMATIK.md) wird unabhängig vom Smoke-Script in der Web UI konfiguriert. Es verbindet eine eigene Instanz mit der Identität aus `BOT_NAME`; den regulären Bot mit derselben Identität vorher trennen. Standardmäßig beobachtet es nur, ohne zu laufen, zu chatten oder ein Bett zu verwenden. Der ausdrücklich aktivierte Modus `SMOKE_SLEEP_MODE=self` legt den Bot selbst in ein Bett in Klickreichweite. Kein Modus bestätigt nach einem Tod einen Respawn. Ein gegebenenfalls erforderlicher initialer Spawn-Handshake bleibt aktiv.

## Vorbereitung

- Node.js 24, installierte Projektabhängigkeiten und die vorhandene Serverkonfiguration verwenden.
- Den Bot an einem sicheren Standort in der Oberwelt abstellen. Nicht im Bett starten.
- Ein zweiter Spieler benötigt ein nutzbares Bett. Seine Schlafversuche müssen serverseitig erlaubt sein.
- Bei mehreren Spielern sollten während des Tests nur die abgesprochenen Schlafaktionen stattfinden. Sonst lassen sich serverweite Ereignisse keinem Spieler zuordnen.
- `OBSERVE_PLAYER` ist der exakte Ingame-Name des zweiten Spielers. Der Beobachter darf nicht dieselbe Identität verwenden.

## Zwei getrennte Läufe

Naher Spieler: Den zweiten Spieler vor dem Start mit seinem Bett neben dem Bot platzieren.

```sh
OBSERVE_PLAYER='Spielername' SMOKE_SLEEP_SCENARIO=near SMOKE_SECONDS=180 pnpm smoke:sleep
```

Entfernter Spieler: Den zweiten Spieler **vor dem Start** mit seinem Bett außerhalb der Entity-Tracking-Reichweite des Bots platzieren. Die Entfernung muss die serverseitige Sicht-/Tracking-Reichweite überschreiten; 32 Blöcke allein genügen dafür nicht. In derselben Dimension bleiben. Danach:

```sh
OBSERVE_PLAYER='Spielername' SMOKE_SLEEP_SCENARIO=far SMOKE_SECONDS=180 pnpm smoke:sleep
```

Der Paketbefehl kompiliert TypeScript und lädt eine vorhandene `.env`. Explizite Umgebungsvariablen haben Vorrang. Alternativ nach `pnpm build` mit zusätzlichen Konfigurationsdateien starten:

```sh
OBSERVE_PLAYER='Spielername' SMOKE_SLEEP_SCENARIO=near node --env-file=.env --env-file=config/smoke.env scripts/smoke-sleep.cjs
```

Auf `READY` warten. Dann mit dem zweiten Spieler ins Bett gehen, nach Möglichkeit einige Sekunden liegen bleiben, aufstehen und erneut hineinlegen. Die Uhrzeiten dieser Aktionen zum Konsolenprotokoll vergleichen. Die Meldung, dass weitere Spieler schlafen müssen, ist erwartbar: Der Zielspieler kann bereits schlafen, während der unbewegte Beobachter noch wach ist. Ein Überspringen der Nacht ist für die Erkennung nicht erforderlich. Ein sofortiger Nachtsprung ist ebenfalls relevante Beobachtung; für einen zweiten Versuch muss Schlafen erneut möglich sein. Das Script ändert weder Zeit noch Wetter oder Spielregeln. Die Beobachtungsdauer beginnt beim Spawn; Standard sind 180 Sekunden, erlaubt sind 1–7200 Sekunden.

## Bericht und Auswertung

Jeder Lauf schreibt `data/sleep-smoke-<near|far>-<Zeitstempel>.json`. Berichte bleiben im ignorierten Verzeichnis `data/`; sie enthalten Spielernamen und Positionen, aber keine vollständigen Login-, Identitäts- oder Chatpakete.

Erfasst werden:

- Bot-Startposition und Dimension sowie alle empfangenen `add_player`-Namen mit Runtime-ID und Position, jeweils in Konsole und Bericht. So lassen sich abweichende Schreibweisen des Zielspielernamens erkennen. Der Abgleich mit `OBSERVE_PLAYER` bleibt exakt, einschließlich Groß-/Kleinschreibung und Leerzeichen; nur der passende Spieler setzt `targetTracked` und wird auf Schlafmetadaten geprüft.
- Sämtliche dekodierten Metadaten des Zielspielers aus `add_player` und jedem `set_entity_data`-Paket: vollständige Einträge mit Schlüssel, Typ und Wert im Feld `metadata`, einschließlich aller Flag-Werte und unbekannter Felder. Auch wiederholt übertragene Werte werden erfasst. Empfangszeit und, bei `set_entity_data`, Server-Tick stehen am Ereignis. Große Ganzzahlen werden ohne Präzisionsverlust als Dezimalstrings gespeichert. Das erfasst die empfangenen Anfangswerte und Änderungen; es ergänzt keine vom Server nicht übertragenen Felder.
- Korrigierte Schlafzustände als `sleep_state` mit `sleeping`, `transition` (`initial`, `entered_bed`, `left_bed`) und den ausgewerteten Rohbits unter `evidence`. `initial` beschreibt den ersten beobachteten Zustand und zählt nicht als Hinlegen oder Aufstehen. `targetSleepState` enthält den letzten erkannten Zustand; `sleepTransitions.entered` und `.left` zählen die beobachteten Wechsel. Beim Verlust der Entity wird der aktuelle Zustand `unknown`, ohne ein Aufstehen zu erfinden.
- Kompakte Änderungen von `player_bed_position` und `bed_enter_position`, zusätzlich zu den vollständigen Metadaten.
- Schlafbezogene `player_action`-Pakete, falls der Server solche Pakete sendet. Die Existenz einer clientseitigen Aktion garantiert keine Zustellung vom Server.
- `level_event` mit `players_sleeping` (9800) oder `sleeping_players` (9801), jeweils mit unverändertem `data`-Wert und Empfangszeit. Im Selbstschlaf-Modus werden zusätzlich alle anderen `level_event`-Ereignisse aufgezeichnet; nur die beiden Schlafereignisse erhöhen `levelEventsObserved`.
- Alle zugelassenen Servertexte aus `text` (unter anderem `translation`, `system`, `raw` und `json`) und alle `set_title`-Meldungen als `server_message`, ohne Schlüsselwortfilter. Normale Chat-/Flüsternachrichten und Texte mit gesetztem `source_name` werden ausgeschlossen. Zusätzlich erscheinen schlafbezogene Texte als `sleep_notice`; dieser ergänzende Filter berücksichtigt auch `skip…night`. So bleiben etwa `multiplayer.playersSkippingNight` und lokalisierte Texte im Bericht sichtbar. Hinweise, die nur lokal beim schlafenden Spieler erscheinen, kann der Beobachter nicht sehen. Texte allein ändern weder Schlafzustand noch Nachtsprungbewertung.
- `packetCounts` zählt sämtliche empfangenen Paketnamen direkt am allgemeinen `packet`-Ereignis, jeweils einmal vor der inhaltlichen Filterung. Auch nicht weiter ausgewertete Pakete stehen dort. Der Zähler speichert keine Paketnutzdaten; Login- und Identitätspakete sowie Chat-/Flüstertexte werden dadurch nicht in den Bericht übernommen.
- `sync_world_clocks` wird mit allen dekodierten Feldern aufgezeichnet: Registry, Zustandsupdates und Markeränderungen. Clock- und Marker-IDs werden ohne Präzisionsverlust als Strings gespeichert. `worldClocks` enthält den letzten Stand je Clock-ID mit `name`, `time` und `paused`. Die Registry ordnet IDs Namen zu; nur `minecraft:overworld` wird für die Zeitsprungauswertung verwendet. Andere und noch nicht zugeordnete Uhren bleiben sichtbar, liefern aber keinen Nachweis für einen Nachtsprung in der Oberwelt. Registry-Neuinitialisierungen setzen die Vergleichsbasis zurück. Markeränderungen oder reine Pause-Umschaltungen gelten nicht als Zeitsprung. Aufbau und Namenszuordnung folgen der [Protokolldefinition](https://mojang.github.io/bedrock-protocol-docs/1.26.65/types/world-clock-data/) und [Microsofts World-Clock-Dokumentation](https://learn.microsoft.com/en-us/minecraft/creator/documents/worldclocks?view=minecraft-bedrock-stable).
- Die strukturierte Serverübersetzung `multiplayer.playersSkippingNight` erzeugt zusätzlich `night_skip_announcement` und setzt `nightSkipAnnouncementObserved`. Das weist die Serverankündigung nach, ohne daraus automatisch einen gemessenen Zeitsprung oder die Beteiligung eines bestimmten Spielers abzuleiten. Normale Chatnachrichten oder bloßer Rohtext mit diesem Schlüssel zählen nicht als strukturierte Ankündigung.
- Restzahl aus strukturierten Übersetzungsmeldungen `chat.type.sleeping`: `parameters[0]` ist der schlafende Spieler, `parameters[1]` die Zahl der **weiteren** benötigten Schläfer. Das bestätigt [Mojangs Sprachdatei](https://github.com/Mojang/bedrock-samples/blob/main/resource_pack/texts/en_US.lang). Beispiel: `["MrHDready", "1"]` bedeutet, dass noch ein Spieler schlafen muss. Das Script schreibt ein Ereignis `remaining_players` und die letzte Momentaufnahme `remainingPlayers` mit `count`, `sleeper` und `at`. Die Zahl wird nicht aus Online-Spielern geschätzt und nicht bei fehlenden Aufsteh- oder Austrittsmeldungen fortgeschrieben. Ausbleibende Meldungen bedeuten nicht null fehlende Spieler.

## Selbst hinlegen und auf den Spieler warten

```sh
OBSERVE_PLAYER='MrHDready' SMOKE_SLEEP_MODE=self pnpm smoke:sleep
```

Dieser aktive Test benutzt den vorhandenen Bot-Controller für Chunkdaten, Inventar und Blockinteraktion, lädt aber keine Farmer-/Collector-Einstellungen und aktiviert keine Arbeitsaufträge. Vorher die reguläre Instanz derselben Identität trennen. Der Bot muss **wach und in der Oberwelt** neben einem freien, unverbauten Bett stehen. Das Script wählt einen leeren Hotbar-Slot und klickt mit leerer Hand; es läuft nicht zum Bett. Ist die Hotbar voll, öffnet es zuerst sein eigenes Inventar per `interact/open_inventory` und wartet auf `container_open`. Danach verschiebt es den gesamten Stack aus Slot 0 in den ersten freien Hauptinventarplatz. Erst nach Serverbestätigung, bestätigtem Leerstand und bestätigtem Schließen des Inventars wird der Bettklick versucht. Öffnen und Schließen haben jeweils ein Zeitlimit von drei Sekunden. `opening_inventory`, `inventory_opened`, `freeing_hotbar`, `inventory_move_response`, `hotbar_freed` und `inventory_closed` protokollieren den Vorgang; Ablehnungsstatus bleiben im Bericht und Fehlertext erhalten. Das Item bleibt im Hauptinventar, auch nach Ende oder Abbruch des Tests; es wird nichts abgeworfen. Sind Hotbar und Hauptinventar vollständig belegt, bricht der Test mit einem klaren Fehler ab, ohne Gegenstände zu entfernen. Ein erfolgreicher Bettklick kann den Respawnpunkt des Bots ändern.

1. Den zweiten Spieler zunächst wach lassen. Die Serverregeln müssen für den gewünschten Test mindestens zwei gleichzeitige Schläfer verlangen. Das Script ändert diese Regeln nicht.
2. Nach dem Spawn erscheint `READY`. Der Bot sucht bekannte freie Bett-Kopfteile maximal 4,5 Blöcke vom Blickpunkt entfernt und versucht alle fünf Sekunden einen Bettklick. So entscheidet der Server, wann Schlafen erlaubt ist, einschließlich Gewitter. Tageslicht, Monster, belegte oder blockierte Betten werden in empfangenen Meldungen sichtbar. Fehlen geeignete geladene Betten, wartet er weiter bis zum Zeitlimit.
3. Auf `WAITING: Bot is sleeping` warten. Erst dann `MrHDready` in ein anderes Bett legen. Die eigene Schlafbestätigung und Restzahlen werden bereits während des Wartens protokolliert. Eine Meldung über weitere benötigte Schläfer hindert den Bot nicht daran, im Bett zu bleiben.
4. Nach dem serverseitigen Aufwachen zeichnet das Script **zehn Sekunden** weiter auf und beendet sich selbst. Weitere Bettklicks werden nicht gestartet. Paketnamen, Servermeldungen und Zustands-/Zeitpakete werden auch während dieser Nachlaufzeit erfasst. `postWakeUntil` enthält das geplante Ende als Unix-Zeit in Millisekunden; `postWakeCompleted` zeigt, ob der Nachlauf vollständig war.

Die drei Bewertungen stehen getrennt unter `assessments` und erscheinen auch in der abschließenden Konsolenausgabe:

| Feld | Ergebnis | Bedeutung |
| --- | --- | --- |
| `sleepCycle.result` | `passed` oder `not_completed` | Für `passed` sind ein Bettklick, bestätigtes eigenes Schlafen, eine erreichte Wartephase und bestätigtes eigenes Aufwachen erforderlich. |
| `partner.result` | `observed`, `not_observed` oder `not_applicable` | Bestätigte Metadaten oder eine strukturierte Schlafmeldung des Zielspielers während des eigenen Schlafens wurden empfangen oder fehlen. Fehlende Meldungen beweisen nicht, dass der Spieler wach blieb. Im Solo-Szenario ist die Partnerprüfung nicht vorgesehen. |
| `nightSkip.result` | `time_jump_observed`, `announced` oder `not_observed` | Ein deutlicher Sprung in `set_time` oder der zugeordneten Overworld-Uhr aus `sync_world_clocks` wurde nach Beginn des eigenen Schlafens erkannt. Ohne Zeitnachweis reicht eine strukturierte Serverankündigung für `announced`. Fehlt beides, bleibt das Ergebnis `not_observed`. Ein Zeitsprung allein beweist seine Ursache nicht. |

Unter `nightSkip.announcement` und `nightSkip.timeJump` steht jeweils unabhängig `observed` oder `not_observed`. Damit bleibt eine Ankündigung auch bei gleichzeitig gemessenem Zeitsprung ausdrücklich sichtbar. `world_time_jump` nennt Zeitquelle, vorherigen und neuen Wert sowie den berechneten Vorlauf; bei World Clocks zusätzlich Clock-ID und Namen. Zeitvergleiche werden pro Quelle und Clock-ID getrennt geführt, damit ein Wechsel zwischen Uhren keinen künstlichen Sprung erzeugt. Die Erkennung verwendet den üblichen Tageszyklus von 24000 Ticks und verlangt einen Vorlauf deutlich über der anhand der Empfangszeiten erwarteten normalen Fortschreibung.

Ein vollständig erkannter eigener Schlafzyklus ergibt `result: observed` mit Exit-Code 0, auch wenn Partner- oder Zeitnachweise fehlen. Diese beiden fehlenden Nachweise machen den eigenen Ablauf nicht mehr pauschal `inconclusive`. Verbindungsfehler, Tod oder ein Abbruch bleiben eigenständige Ergebnisse; die getrennten Bewertungen zeigen die bis dahin gesammelten Nachweise.

Die Wartezeit ab Spawn beträgt in diesem Modus standardmäßig **1500 Sekunden (25 Minuten)**, damit auch ein Start bei Tageslicht möglich ist. `SMOKE_SECONDS` überschreibt sie, maximal 7200 Sekunden. Beginnt der Nachlauf kurz vor diesem Zeitlimit, darf er noch seine vollen zehn Sekunden aufzeichnen. Kein Erfolg oder kein Aufwachen bis zum Zeitlimit ergibt `inconclusive`. SIGINT/SIGTERM speichert die bisherigen Daten als `interrupted`; die Verbindung wird geschlossen. Es wird kein zusätzlicher Aufsteh-Befehl gesendet.

Berichte heißen `data/sleep-smoke-self-<near|far|solo>-<Zeitstempel>.json`. Zusätzlich zu den normalen Metadaten enthalten sie `selfSleepState`, `selfSleepingObserved`, `selfSleepTransitions`, `selfSleepPhase`, `bedAttempts`, Bettkandidaten sowie `set_time`- und `sync_world_clocks`-Pakete. Bettklicks sind als `self_sleep`-Ereignisse sichtbar. `remainingPlayers` bleibt die letzte datierte Servermeldung, auch wenn der Bot inzwischen aufgewacht ist.

Für einen aktiven Fernlauf zusätzlich `SMOKE_SLEEP_SCENARIO=far` setzen und den zweiten Spieler bereits vor dem Verbinden außerhalb der Entity-Reichweite platzieren. Im Selbstschlaf-Modus ist das Szenario sonst `near`. `assessments.partner.range` unterscheidet `near`, `not_entity_tracked` und `entity_tracked`. Wird der Zielspieler im Fernlauf als Entity übertragen, ist kein Fernnachweis erbracht. Das ändert die eigenständige Bewertung des eigenen Schlafablaufs nicht. Passive Fernläufe behalten ihre bisherige `inconclusive`-Regel bei.

## Solo-Test ohne zweiten Spieler

```sh
SMOKE_SLEEP_MODE=self SMOKE_SLEEP_SCENARIO=solo pnpm smoke:sleep
```

Den normalen Bot vorher trennen und alle weiteren Spieler ausloggen, während die Script-Instanz verbunden bleibt. Das Script loggt keine anderen Spieler aus und ändert keine Schlafregeln. Die Serverregeln müssen zulassen, dass der Bot als einziger Schläfer die Nacht überspringt. Bett, Reichweite und Inventarablauf entsprechen dem aktiven Test. Der Bot darf bei Tageslicht warten; sobald der Server den Bettklick erlaubt, legt er sich selbst hin und wartet auf serverseitiges Aufwachen. Nach dem Aufwachen bleibt die Aufzeichnung weitere zehn Sekunden aktiv.

`OBSERVE_PLAYER` ist hierfür nicht erforderlich und wird auch dann ignoriert, wenn es noch in der Umgebung gesetzt ist. `assessments.partner.result` lautet `not_applicable`, `partner.range` lautet `solo`. Das ist kein fehlgeschlagener Partnernachweis. Ankündigung und gemessener Zeitfortschritt werden wie beim gemeinsamen Test separat bewertet. Der Solo-Lauf prüft den eigenen Schlafablauf und die Zeit-/Servermeldungen; er ersetzt keinen Test der Erkennung anderer Spieler.

| Ergebnis | Exit-Code | Aussage |
| --- | --- | --- |
| `observed` | 0 | Passiv: Schlaf-Level-Event oder Schlaf-Bit des Zielspielers empfangen. Aktiv: eigener Schlafablauf bestanden; Partnerbeteiligung und Nachtsprung separat bewertet. |
| `failed` | 1 | Verbindungsfehler, Spawn-Timeout oder Tod; keine erfolgreiche Beobachtung. Konfigurationsfehler führen ebenfalls zu Exit-Code 1, ohne Bericht. |
| `no_signal` | 2 | Kein bestätigendes Signal innerhalb des Fensters. Das beweist nicht, dass der Server grundsätzlich keine Schlafsignale unterstützt. |
| `inconclusive` | 2 | Aktiver Schlafablauf unvollständig oder Wartezeit abgelaufen. Bei passiven Fernläufen auch: Zielspieler war als Entity erfasst. |
| `interrupted` | 2 | Mit SIGINT/SIGTERM abgebrochen; der Bericht enthält die bisherigen Beobachtungen. |

Bettkoordinaten, Körpermaße, eine Schlafaktion oder eine Meldung allein gelten nicht als Bestätigung, dass ein Spieler tatsächlich schläft. `targetSleepingObserved` steht nur nach einem positiven, korrigiert ausgewerteten Schlaf-Bit des bekannten Zielspielers auf `true`; es bleibt danach als Nachweis erhalten, auch wenn der Spieler wieder aufsteht. Widersprechen sich die beiden Schlaf-Bits in einem Paket, wird `sleep_conflict` protokolliert und der aktuelle Zustand bleibt unbekannt.

## Geprüfte Bitzuordnung

Die installierte Datenversion `minecraft-data@3.119.0`, Bedrock `1.26.60`, hat in `MetadataFlags1` 65 Einträge: `laying_down` steht dort an Index 64. Ein 64-Bit-Wort deckt jedoch nur Index 0–63 ab. In `MetadataFlags2` fehlt dieser erste Eintrag; die Liste beginnt mit `sneezing`. Deshalb liegt das benannte `sleeping` dort fälschlich an lokalem Bit 11 und `wants_to_wake` an Bit 12.

Die [PocketMine-Protokolldefinition für Entity-Flags](https://github.com/pmmp/BedrockProtocol/blob/master/src/types/entity/EntityMetadataFlags.php) und die [Endstone-Protokolldefinition](https://github.com/EndstoneMC/bedrock-protocol/blob/main/protocol/actor.py) stimmen für die relevanten globalen Indizes überein: `LAYING_DOWN = 64`, `SLEEPING = 76`, `WANTS_TO_WAKE = 77`. Im zweiten Wort sind Schlafen und Aufwachwunsch damit Bit 12 (`4096`) und Bit 13 (`8192`). Das Script liest diese Bits direkt aus `flags_extended._value`; die vollständigen dekodierten Metadaten bleiben als Diagnose unverändert erhalten und enthalten weiterhin die falschen Namen des installierten Schemas. Abhängigkeiten und Paketpatches werden durch diese lokale Script-Korrektur nicht verändert.

Zusätzlich wertet das Script `player_flags` aus. [PocketMine definiert `SLEEP = 1`](https://github.com/pmmp/BedrockProtocol/blob/master/src/types/entity/PlayerMetadataFlags.php) als Bitindex, also Maske `2`. Beide Werte werden bei gemeinsamer Übertragung auf Übereinstimmung geprüft. Ein Paket mit nur einem der beiden Werte kann den Zustand ebenfalls aktualisieren, ohne auf alte Werte aus einem früheren Paket zu warten.

Die bereinigte Live-Fixture `test/fixtures/bedrock-sleep-metadata.json` prüft die tatsächlich empfangene Folge: bereits schlafend beim Erscheinen, viermal Aufstehen und dreimal erneutes Hinlegen. Sie enthält nur relevante Metadaten und Server-Ticks, keine Namen, IDs oder Weltpositionen. Der Replay-Test prüft die Auswertung dieser Aufnahme; er ersetzt keinen neuen Live-Test und belegt keine Erkennung entfernter Spieler.

`observed` bestätigt den Paketempfang, keine serverweite Schlafzählung: Die Bedeutung von `level_event.data`, die Zuordnung zum Zielspieler und die Reaktion beim Aufstehen müssen anhand der kontrollierten Aktionen verglichen werden. Für eine spätere Automatik besonders prüfen, ob Fernsignale beim Hinlegen **und** Aufstehen eintreffen. Ein einzelnes Ereignis reicht nicht, um einen dauerhaft korrekten Schlafzustand zu führen.
