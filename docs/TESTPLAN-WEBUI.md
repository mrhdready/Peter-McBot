<!-- Code generated/edited by Claude Opus 5.5 -->
# Testplan: Neugestaltete Weboberfläche

Manuelle Prüfung der neuen Oberfläche (`src/ui/`). Die automatisierten Tests (`pnpm test`) decken IDs, Inline-Script, Verbindungs-Umschalter und Zielwahl aus der Trefferliste ab. Dieser Plan prüft Layout und Bedienung im echten Browser.

Ergebnis je Fall eintragen: ✅ ok · ❌ Fehler (mit Beobachtung) · ➖ nicht geprüft.

## 0. Vorbereitung

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| 0.1 | `pnpm install --frozen-lockfile` und `pnpm test` | Build und alle Tests grün; `dist/ui/` enthält `index.html`, `app.js`, `style.css` | |
| 0.2 | Docker-Image bauen und starten | Container startet, Healthcheck grün, `/` liefert die neue Seite (kein 500, kein `ENOENT` für `dist/ui`) | |
| 0.3 | Browser-Konsole öffnen | Keine JS-Fehler und keine CSP-Verletzungen beim Laden | |

## 1. Ohne Verbindung (Archivkarte)

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| 1.1 | Seite laden, Bot getrennt | Kopfleiste: Badge „Getrennt“, Button „Verbinden“ | |
| 1.2 | Karte betrachten | Historische Karte sichtbar (vernebelt), Steuerung oben rechts, Legende unten links | |
| 1.3 | Ziehen, Mausrad, +/−, „Zum Bot“, Dimension wechseln | Verhalten wie bisher; Overlay-Buttons bleiben bedienbar | |
| 1.4 | Maus über die Karte | Zeile unter der Karte zeigt Block, Koordinaten, ggf. „Historische Beobachtung“ | |
| 1.5 | „Suchen“ in der Blocksuche | Button deaktiviert, solange keine Registry geladen ist | |

## 2. Verbinden

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| 2.1 | „Verbinden“ klicken | Badge wechselt über „Verbindet …“ zu „Verbunden“ (grün), Button zeigt „Trennen“ | |
| 2.2 | Panel „Bot“ | Position, Dimension, Chunks, Herzschlag aktualisieren sich | |
| 2.3 | „Trennen“ klicken | Badge „Getrennt“, Button „Verbinden“ | |

## 3. Wegpunkt setzen und anfahren (Desktop, ≥ 900 px)

Kernfall der Neugestaltung: **kein Scrollen der Seite** zwischen Zielwahl und Start.

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| 3.1 | Fenster ca. 1400 × 850 | Karte links, Seitenleiste rechts, Seite selbst scrollt nicht | |
| 3.2 | Auf die Karte klicken | X/Z im Panel „Ziel & Navigation“ gesetzt, 📌 auf der Karte, dünne gestrichelte dunkle Vorschau erscheint; Bot bewegt sich **nicht** | |
| 3.3 | „Navigation starten“ (sichtbar ohne Scrollen) | Bot läuft los, Status „Unterwegs …“, durchgezogener dunkler Restweg mit abgerundeten Ecken | |
| 3.4 | „Stopp“ | Bot hält an, Status „Gestoppt“ | |
| 3.5 | X/Z manuell eintippen | Vorschau aktualisiert sich, 📌 springt mit | |
| 3.6 | Mehrfach zoomen | Linie und Pins behalten ihre Bildschirmgröße; Pinspitze sitzt auf der Zielzelle | |

## 3a. Orte, Verlauf und Pins

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| 3a.1 | Name eingeben, Symbol wählen, „Ziel speichern“ | Ort erscheint in „Orte“ und als 📍 auf der Karte | |
| 3a.2 | „Bot-Position speichern“ ohne Namen | Hinweis „Zuerst einen Namen eingeben“, nichts gespeichert | |
| 3a.3 | Maus auf 📍, 📌 und 🤖 | Overlay mit Symbol/Name, X/Z, Entfernung bzw. Status; verschwindet beim Wegbewegen | |
| 3a.4 | 📍 anklicken | Ort wird Ziel, Vorschau erscheint, keine Bewegung | |
| 3a.5 | Karte über einem Pin ziehen und zoomen | Karte verschiebt/zoomt wie gewohnt, Pins wandern mit | |
| 3a.6 | „Löschen“, dann „Wirklich löschen?“ | Erst der zweite Klick löscht; ohne zweiten Klick setzt sich der Button nach ca. 4 s zurück | |
| 3a.7 | Navigation starten | Ziel erscheint oben unter „Zuletzt angesteuert“; gleiches Ziel erneut rückt nach oben statt doppelt | |
| 3a.8 | Zweiter Browser offen | Neuer/gelöschter Ort erscheint dort ohne Neuladen | |
| 3a.9 | Prozess neu starten | Orte und Verlauf bleiben erhalten | |
| 3a.10 | Mit Tab zu einem 📍 | Fokusrahmen und Overlay; Enter übernimmt das Ziel | |

## 4. Blocksuche

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| 4.1 | Suche mit Limit 100 | Trefferliste scrollt innerhalb des Panels, Tabellenkopf bleibt stehen | |
| 4.2 | In einer Zeile „Ziel“ klicken | X/Z übernommen, Treffer weiß umrandet, Vorschau erscheint, keine Bewegung | |
| 4.3 | Türkisen Marker auf der Karte anklicken | Wie bisher; bei mehreren Y-Treffern erscheinen Auswahl-Buttons | |
| 4.4 | Andere Dimension in der Archivkarte, dann „Ziel“ in der Liste | Ziel wird übernommen (Treffer stammen aus der verbundenen Dimension) | |

## 5. Mobil (< 900 px, z. B. 375 × 812 oder echtes Handy)

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| 5.1 | Seite laden | Karte oben, quadratisch, ohne große Leerflächen; Panels darunter | |
| 5.2 | Leiste unten | X, Z, „Navigation starten“, „Stopp“ immer sichtbar, auch beim Scrollen bis zur Trefferliste | |
| 5.3 | Karte antippen, dann Start in der Leiste | Ziel gesetzt, Start ohne Scrollen möglich | |
| 5.3a | 📍 antippen, dann Overlay antippen | Erstes Tippen zeigt nur das Overlay; zweites Tippen übernimmt den Ort als Ziel | |
| 5.4 | Ende der Seite | Hilfe und Trefferliste werden nicht von der Leiste verdeckt | |
| 5.5 | Karte ziehen | Seite scrollt dabei nicht mit | |

## 6. Tastatur und Barrierefreiheit

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| 6.1 | Mit Tab durch die Seite | Sichtbarer Fokusrahmen; Reihenfolge: Kopfleiste → Karte → Kartensteuerung → Seitenleiste | |
| 6.2 | Karte fokussieren, Pfeiltasten | Zellinfo unter der Karte; Umschalt + Pfeile verschiebt die Karte | |
| 6.3 | Enter / Leertaste auf der Karte | Ziel übernommen | |
| 6.4 | Screenreader (optional) | Statusmeldungen (Vorschau, Navigation, Suche) werden angesagt | |

## 7. Hilfe und Messseite

| # | Schritt | Erwartung | Ergebnis |
|---|---|---|---|
| 7.1 | „Hilfe“ aufklappen | Erklärungen zu Karte, Navigation, Blocksuche | |
| 7.2 | `/?measure=1` öffnen | Panel „Kartenperformance messen“ am Ende der Seitenleiste; Messung läuft durch | |

## Rückmeldung

Bitte Fälle mit ❌ samt Browser, Fenstergröße und Beobachtung (Screenshot hilft) zurückmelden.
