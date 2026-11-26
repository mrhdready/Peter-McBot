# Uhrzeit, Licht und Schlafautomatik

Die Topbar zeigt die Ingame-Zeit als `HH:MM` und das geschätzte lokale Licht am Blickpunkt des Bots als `Licht ≈ 0–15`. Fehlende Werte erscheinen ausdrücklich als unbekannt. Weltzeit kommt bevorzugt aus `sync_world_clocks`, über die Registry der Uhr `minecraft:overworld` zugeordnet. `set_time` bleibt ein Fallback. Laufende Uhren werden zwischen Serverpaketen mit 20 Ticks pro Sekunde fortgeschrieben; pausierte bleiben stehen. Beim Trennen werden Live-Werte gelöscht.

## Einstellungen unter „Bot“

- **Automatisch schlafen** ist standardmäßig ausgeschaltet.
- **Nur wenn andere Spieler schlafen wollen** ist nur bei aktiver Automatik bedienbar. Seine Auswahl bleibt beim Ausschalten erhalten.

Beide Schalter werden atomar unter `data/sleep/` gespeichert, getrennt nach Server, Port, Transport und `MAP_WORLD_ID`. Neustarts übernehmen sie. Fehler beim Speichern werden angezeigt; die bisherige Einstellung bleibt erhalten.

## Ablauf

Die Automatik arbeitet ausschließlich in der Oberwelt. Nacht oder Gewitter lösen sie aus; gewöhnlicher Regen reicht nicht. Ob der konkrete Bettklick erlaubt ist, entscheidet der Server.

1. Navigation, Farmer und Collector werden pausiert. Ein bereits begonnener Kistenzugriff mit bestätigten Transfers wird abgeschlossen, bevor sich der Bot entfernt. Neue Navigations-, Kisten- und Drop-Aufträge warten.
2. Die Automatik prüft bekannte freie Bett-Kopfteile innerhalb von 32 Blöcken nach Entfernung und Erreichbarkeit. Sie baut kein Bett und erkundet keine unbekannten Gebiete. Standplätze und Wege verwenden denselben Planner und dasselbe Terrainmodell wie reguläre Navigation.
3. Am Bett werden freie Belegung, Sicht und Klickreichweite geprüft. Der Bot benutzt eine leere Hand. Bei voller Hotbar wird ein vollständiger Stack in einen freien Hauptinventarplatz verschoben; Öffnen, Transfer und Schließen brauchen Serverbestätigungen. Ohne freien Hauptinventarplatz schlägt der Versuch fehl. Es werden keine Items abgeworfen.
4. Erst korrigierte eigene Schlafmetadaten bestätigen das Hinlegen. Danach sendet der Bot keine Arbeits- oder Bewegungspakete und wartet auf serverseitiges Aufwachen. Eine Meldung über weitere benötigte Schläfer ist kein Fehlschlag.
5. Nach bestätigtem Aufwachen wird das vorherige Navigationsziel vom aktuellen Standort neu geplant. Farmer und Collector behalten Modus und Anker und planen ihre nächsten Schritte vom Bett aus neu. Bereits geerntete Stellen werden als offene Pflanzziele erhalten; veraltete Standplätze und Handbelegungen werden nicht weiterverwendet. Bestätigte Inventarbewegungen werden nicht wiederholt. Eine bereits geerntete Feldstelle wird nach der Pause weiter nachgepflanzt.

Der gesamte Bettanlauf einschließlich Vorbereitung dauert höchstens 60 Sekunden. Entfällt der Anlass vorher, wird abgebrochen. Bei Fehlschlag wird weitergearbeitet; der nächste Versuch erfolgt frühestens nach weiteren 60 Sekunden. Sobald der Bot tatsächlich schläft, gilt das Anlauflimit nicht mehr. Ablehnungen und fehlende Betten erscheinen als Statusmeldung unter „Bot“.

**Stopp** verwirft das pausierte Ziel und wartende Aufträge, beendet Farmer/Collector und sperrt weitere Schlafversuche. Ein neuer manueller Arbeitsauftrag oder Aus- und Einschalten der Automatik gibt die Sperre frei. Ausschalten während eines Schlafablaufs fordert Aufstehen an und setzt die pausierte Arbeit nach bestätigtem Aufwachen fort. Bei fehlender Wachbestätigung bleibt die Arbeit pausiert und die Oberfläche zeigt den Grund.

Reconnects verwerfen alte Schlafsignale, Suchergebnisse und Bettkoordinaten. Navigation wird nicht aus einem früheren Weltzustand übernommen. Die bestehenden Reconnect-Regeln von Farmer und Collector bleiben erhalten. Bettbenutzung kann den Respawnpunkt des Bots ändern.

## Andere Spieler

Nahe Spieler werden anhand ihrer Schlafmetadaten erkannt. `player_flags` wird mit dem wirklichen Schlaf-Bit aus `flags_extended._value` abgeglichen. Die um ein Bit verschobenen benannten erweiterten Flags der installierten Datenversion werden nicht verwendet. Eine bestätigte Wachmeldung beendet den Anlass dieses Spielers; andere schlafende Spieler bleiben berücksichtigt.

Entfernte Spieler lösen nur über die strukturierte Servermeldung `chat.type.sleeping` aus, nicht über normale Chatnachrichten. Eine Fernmeldung gilt höchstens 60 Sekunden als Schlafaufruf. Weitere Meldungen verlängern den laufenden Anlauf nicht. Nach Fehlschlag werden alte Fernaufrufe verworfen; ein weiterer Versuch braucht eine neue Meldung und die Wiederholungspause. Lokal bestätigtes Aufstehen oder eine zuordenbare Abmeldung löscht den gespeicherten Aufruf.

Eine fehlende Fern-Aufstehmeldung kann nicht ersetzt werden: Steht ein entfernter Spieler sofort wieder auf, kann der Bot während seines begrenzten Anlaufs noch zum Bett gehen und gegebenenfalls selbst schlafen.

## Lichtschätzung

Der Decoder liefert keine gemessenen Sky-/Blocklight-Werte. Die Anzeige schätzt Tageslicht aus Zeit und Wetter und lokale Beleuchtung aus bekannten Lichtquellen, Absorption und Ausbreitung durch Nachbarblöcke. Beide Blockschichten werden berücksichtigt, einschließlich Wasser in wassergefüllten Blöcken. Undurchsichtige Decken verhindern direkten Himmelszugang. Unbekannte Zellen ergeben „Licht unbekannt“, wenn sie den Wert beeinflussen könnten. Ergebnisse werden für Position, Weltrevision und Tageslichtstufe zwischengespeichert.

Die Schätzung ist kein Messwert: dynamische Lichtquellen, besondere Blockzustände und die genaue Himmelsdarstellung können abweichen. In Nether und Ende bleibt lokales Licht unbekannt. Licht steuert nicht die Schlafentscheidung; dafür gelten Weltzeit, Gewitter und bestätigte Spielersignale.

## Schnittstellen und Prüfung

`GET /api/status` und SSE enthalten `environment` (Zeit, Uhrtext, Wetter, Lichtschätzung) und `sleep` (Schalter, Phase, Sperre, Wiederholungszeit, Bett und Meldung). `POST /api/sleep` akzeptiert ausschließlich zwei Boolean-Felder:

```json
{"enabled":true,"onlyWithPlayers":false}
```

Automatisierte Tests prüfen Protokollbits, Uhr-Pausen, Lichtausbreitung, Persistenz, HTTP-Validierung, UI-Schalter, Bettanlauf, Wiederaufnahme, Stopp, veraltete Antworten und Inventarbestätigungen. Die vorherigen [Smoke-Tests](SCHLAF-SMOKE.md) belegen reale Bettinteraktion, Schlafmetadaten und den Zeitsprung. Sie ersetzen keinen vollständigen Live-Lauf der neuen Automatik mit unterbrochener Arbeit.
