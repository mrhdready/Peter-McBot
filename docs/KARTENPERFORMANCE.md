# Kartenperformance und Messmodus

In einer kurzen Vergleichsprüfung mit Chrome 157 unter Linux, sichtbarem Tab und 112 × 112 Blöcken wurden vor und nach der Rasteroptimierung jeweils drei Läufe durchgeführt: zehn Sekunden Ruhe, zehn Sekunden Cursorbewegung und 60 erzwungene vollständige Gelände-Neuaufbauten je Lauf.

| Messwert | Vorher | Optimiert |
| --- | ---: | ---: |
| Gesamter Gelände-Neuaufbau p95 | 24,6 ms | 8,6 ms |
| rAF-FPS beim vollständigen Neuaufbau | 43,0 | 49,4 |
| Container-CPU in Ruhe, Mittel | 13,3 % | 8,6 % |
| Container-CPU bei Cursorbewegung, Mittel | 14,4 % | 11,6 % |
| Größte CPU-Intervallspitze über alle Szenarien | 49,5 % | 24,4 % |
| Größter Container-Speicherwert | 196,8 MiB | 180,4 MiB |

Das Container-Limit blieb bei 0,5 CPU und 256 MiB. CPU-Prozente beziehen sich auf einen Kern. Die Containerwerte erfassen den gesamten Bot einschließlich Transport, Worker, Speicherung, Healthchecks und Messabfragen; sie isolieren nicht die serverseitige Kartenarbeit. Besonders die kurzen Gelände-Stressphasen sind störanfällige Backend-Messfenster. Quotenbedingtes CPU-Throttling blieb messbar.

Die Optimierung verwendet einen Pixelpuffer je Kachel statt einzelner Canvas-Aufrufe pro Block, wiederverwendbare RGB-Werte, getrennte Gelände-/Overlay-Ebenen und gebündelte Mausereignisse. Unveränderte Archivzellen benötigen keine vollständigen JSON-/Hash-Vergleiche; vollständig geladene Chunkbereiche überspringen die erneute Anfragesuche. Der regelmäßige Healthcheck verwendet `node:http` statt des allgemeinen `fetch`-Clients, bei unverändertem Prüftakt.

## Selbst messen

Die normale Webadresse mit `/?measure=1` öffnen. Bei geladener Karte und ohne aktive Navigation „Kartenmessung starten“ wählen; den Tab während der Messung sichtbar lassen. Der Modus sendet keine Navigationsbefehle. Das Ergebnis erscheint als JSON mit Einzelmessungen und Laufzeitsnapshots.

`GET /api/map-performance` liefert `process.cpuUsage()`, `process.memoryUsage()` sowie verfügbare cgroup-v2-Zähler für CPU-Zeit, Throttling, Speicher und Limits. CPU-Raten ergeben sich aus Zählerdifferenzen und monotoner Zeit. Identische Zeitstempel aus dem kurzzeitigen Metrikcache werden bei Spitzenwerten verworfen.

## Grenzen

Renderzeiten erfassen JavaScript und das Einreichen der Canvas-Befehle, keine bestätigte GPU-Präsentation. FPS bezeichnen den rAF-Takt; der beobachtete Leerlauf dieser Browserumgebung lag bei ungefähr 50 Hz. Die Timerauflösung betrug etwa 0,1 ms. Browser-JavaScript-Heap ist nicht der gesamte Browser-RAM; Gesamt-CPU und Gesamt-RAM des Browsers sind nicht erfasst. Node-RSS und cgroup-Speicher werden unterschiedlich zugerechnet.

Diese Kurzprüfung ist kein Langzeitnachweis und keine Garantie für andere Geräte, Weltregionen oder viele gleichzeitige Clients. Der nachträglich erweiterte Übersichtszoom bis 448 × 448 Blöcke wurde funktional und visuell geprüft, aber nicht mit dieser vollständigen Performance-Messreihe vermessen. Historische Flächen werden inzwischen mit leichtem hellem Nebel dargestellt.

Interne Betriebsadressen, Projekt-/Auftragskennungen, Weltpositionen und Laufzeit-Screenshots sind absichtlich nicht Bestandteil dieser Public-Dokumentation.
