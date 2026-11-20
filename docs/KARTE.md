# Persistente Karte und Rendering

Stand: 19.11.2026. Die Karte speichert beobachtete Oberflächen, keine vollständigen Chunks. Die Daten dienen der Orientierung. Navigation, Vorschau und Blocksuche verwenden weiterhin ausschließlich den aktuellen Weltcache.

## Aufzeichnung und Weltzuordnung

`MAP_WORLD_ID=default` bezeichnet die aktuelle Welt. Beim Ersetzen oder Zurücksetzen einer Welt muss ein neuer Schlüssel gesetzt werden, beispielsweise `MAP_WORLD_ID=farm_2026_2`. Zulässig sind 1–80 Buchstaben, Ziffern, Unterstriche oder Bindestriche. Ein Weltwechsel auf derselben Serveradresse wird nicht automatisch erkannt.

Der Archivpfad unter `data/maps/` wird aus normalisierter Serveradresse, Port, Transport und Kartenschlüssel abgeleitet. Dimensionen liegen in getrennten Unterordnern. Docker und das generierte Arcane-Paket verwenden das vorhandene Volume unter `/app/data`; es wird kein weiteres Volume benötigt. Bestehende Archive werden nicht automatisch gelöscht. Der Plattenbedarf wächst mit der erkundeten Fläche.

Der Bot erfasst alle geladenen Oberflächen unabhängig von geöffneten Browsern. Pro 50-ms-Tick werden höchstens zwei geänderte Chunkspalten verarbeitet; vor Verdrängung einer Spalte oder Weltreset werden offene Beobachtungen ebenfalls übernommen. Die Oberflächenberechnung wird anhand unveränderter Abschnittsreferenzen wiederverwendet. Identische Blockupdates erzeugen keine neue Revision.

Jede 16 × 16-Kachel enthält Blockname, Höhe und Bestätigungsstatus pro X/Z-Zelle. Unbekannte Beobachtungen löschen keine gespeicherte Oberfläche. Eine unvollständige neue Beobachtung ersetzt keine zuvor bestätigte Oberfläche. Vollständig bekannte Luft darf alte Blöcke ersetzen. „Unvollständig“ und „historisch“ bleiben unterschiedliche Eigenschaften.

Änderungen werden gebündelt ungefähr alle fünf Sekunden gespeichert; bei Cache-Verdrängung kann früher geschrieben werden. Dateien werden zunächst unter einem temporären Namen geschrieben und anschließend atomar ersetzt. Bei regulärem SIGINT/SIGTERM werden die noch offenen Beobachtungen gespeichert. Ein Prozessabsturz kann das letzte ungespeicherte Intervall verlieren; atomarer Dateiersatz ist keine Garantie gegen Stromausfälle. Beschädigte Archivdateien werden als Fehler gemeldet und nicht automatisch überschrieben.

Der Server hält höchstens 128 Kacheln im regulären Cache und bis zu 256 ausstehende Beobachtungen. Zusätzlich merkt er sich bis zu 2048 nicht vorhandene Kacheldateien, damit große unbekannte Kartenflächen nicht bei jeder Aktualisierung erneut Dateizugriffe auslösen; beim Speichern einer neuen Kachel wird diese Fehlanzeige entfernt. Bei überfülltem Puffer werden weitere Beobachtungen mit einer bleibenden Fehlermeldung abgewiesen; bereits gespeicherte Daten bleiben erhalten. Schreibfehler erscheinen im Prozesslog und Kartenstatus. Dieser Fehlerzustand benötigt eine Prüfung des Datenträgers und gegebenenfalls einen Neustart.

## Darstellung und Bedienung

Das Gelände liegt auf einer eigenen Canvas-Ebene. Jede sichtbare Kachel erhält ein wiederverwendbares Raster. Beim vollständigen Neuaufbau wird ein Pixelpuffer mit einem `putImageData` je Kachel übertragen; aufgelöste Blockfarben werden begrenzt zwischengespeichert. Cursor, Bot, Route, Suchtreffer und Ziel werden auf einer separaten transparenten Ebene gezeichnet. Mausbewegungen werden mit `requestAnimationFrame` zusammengefasst; Bewegungen innerhalb derselben Zelle zeichnen nicht erneut.

- Die Karte füllt die Hauptfläche; Zoom, „Zum Bot“ und Dimensionswähler liegen als Overlay oben rechts, die Farblegende unten links. Ausführliche Erklärungen stehen im aufklappbaren Bereich „Hilfe“ der Seitenleiste.
- Ziehen verschiebt den Ausschnitt; ein Ziehen wählt kein Navigationsziel.
- Mausrad und +/− ändern den Zoom. „Zum Bot“ aktiviert erneut die Verfolgung der Botposition und öffnet dessen Dimension.
- Pfeiltasten lesen Zellen; Enter oder Leertaste übernimmt ein Ziel. Umschalt + Pfeiltasten verschiebt den Ausschnitt.
- Der Dimensionswähler erlaubt die Orientierung in gespeicherten Oberflächen anderer Dimensionen. Ziele lassen sich nur in der verbundenen Dimension wählen.
- Ein leichter heller Nebel (16 % Deckkraft) kennzeichnet historische Beobachtungen; die darunterliegenden Blockfarben bleiben weitgehend erhalten. Gelbes Muster bedeutet fehlende Daten oberhalb der bekannten Oberfläche. Unbekannte Zellen bleiben grau.

Der sichtbare Ausschnitt startet weiterhin mit 112 × 112 Blöcken und lässt sich bis 448 × 448 Blöcke erweitern. Das entspricht vierfacher Breite und sechzehnfacher Fläche. Große Ausschnitte werden in Anfragen von jeweils höchstens 8 × 8 Kacheln zerlegt, mit höchstens vier parallelen Anfragen. Vollständig unbekannte Kacheln werden bereits im Manifest als leer markiert und benötigen keinen eigenen Datenabruf. Die aktuell sichtbaren Kacheln werden bis zur nächsten Aktualisierung wiederverwendet; zusätzlich hält der Browser höchstens 128 Kacheln im LRU-Cache. Es wird keine vollständige Weltkarte in den Browser geladen.

## Änderungserkennung und API

`GET /api/map/tiles?dimension=0&x=-4&z=-4&width=8&height=8` liefert Koordinaten, SHA-256-Fingerabdrücke und eine `empty`-Markierung für vollständig unbekannte Chunkkacheln. X/Z bezeichnen hier Chunkkoordinaten. Breite und Höhe müssen jeweils zwischen 1 und 8 liegen. Maximal vier Kartenanfragen werden gleichzeitig bearbeitet; weitere erhalten HTTP 429.

`GET /api/map/tile?dimension=0&x=-1&z=-2` liefert eine einzelne Kachel. Ihr Fingerabdruck berücksichtigt Oberflächeninhalt, Vollständigkeit und die aktuelle Bestätigung jeder Zelle durch geladene Daten. Dadurch wird auch ein Wechsel zwischen aktuell und historisch erkannt. Stimmen Fingerabdrücke überein, verwendet der Browser Daten und Raster erneut. `If-None-Match` mit dem ETag ergibt bei unverändertem Inhalt HTTP 304 ohne Body.

Die Antworten enthalten die aktuelle Weltsitzung. Veraltete Antworten nach Weltwechsel oder geänderten Ausschnitten werden verworfen. Bei Änderungen zwischen Manifest und Kachelabruf wird eine weitere Aktualisierung vorgemerkt.

`GET /api/map` bleibt für bisherige Clients als unpersistierter Live-Ausschnitt verfügbar. Eingebettete Webserver ohne übergebenes `MapArchive` verwenden weiterhin diesen Endpunkt. Der reguläre Prozess aus `main.ts` aktiviert das Archiv und die Kacheloberfläche.

## Prüfungen und Grenzen

Automatisierte Tests prüfen Persistenz nach Neustart, Trennung der Welten und Dimensionen, Schutz bestätigter Oberflächen, bedingte HTTP-Abrufe, begrenzte Ausschnitte und Aufzeichnung ohne Dashboard. Browserlogiktests prüfen Rasterwiederverwendung, gebündelte Mausereignisse, historische Darstellung, Übersicht bis 448 × 448 Blöcke, leere Kacheln, Zoom und verspätete Antworten.

Der Messmodus wird mit `/?measure=1` geöffnet und startet erst nach Betätigen der Schaltfläche. `GET /api/map-performance` liefert Node- und cgroup-Laufzeitzähler. Renderzeiten erfassen JavaScript-/Canvas-Aufrufe; FPS bezeichnen den rAF-Takt, keine bestätigten GPU-Präsentationen. Gesamt-CPU und Gesamt-RAM des Browsers werden nicht gemessen. Ein größerer Ausschnitt ist nicht durch die Messwerte des Standardausschnitts abgedeckt.

Allgemeine Ergebnisse und Grenzen: [Kartenperformance](KARTENPERFORMANCE.md). Architektur: [ARCHITEKTUR.md](ARCHITEKTUR.md). Interne Betriebsberichte, Bereitstellungsadressen, Weltpositionen und Laufzeit-Screenshots sind nicht Teil dieser Public-Kopie.
