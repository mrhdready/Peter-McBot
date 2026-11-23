# MC Bot

Minecraft-Bedrock-Bot mit Websteuerung für einen vorhandenen Server. TypeScript und Node.js 24, ein Prozess mit getrennten Modulen für Bot, Weltmodell und HTTP/SSE.

## Funktionen

- AFK-Verbindung über HTTP-NetherNet; manuelles Verbinden und Trennen, Login-Timeout und begrenzte Wiederverbindung. Keine automatische Verbindung beim Prozessstart.
- Zentraler Welt-State und 20-Hz-Herzschlag; Chunkdecodierung im Worker. Bekannte und unbekannte Weltdaten bleiben unterscheidbar.
- Weboberfläche mit der Karte im Zentrum und einer Seitenleiste (Ziel & Navigation, Orte, Bot, Umgebungssuche, Spieler, Inventar, Farm, Collector, Skin, Hilfe; alle außer Ziel & Navigation einklappbar). Die Spielerliste zeigt alle Spieler auf dem Server, Spieler in Reichweite mit Entfernung. Zielwahl und Start ohne Scrollen; auf schmalen Bildschirmen bleibt eine Navigationsleiste unten fixiert. Manuelle Prüfschritte: [docs/TESTPLAN-WEBUI.md](docs/TESTPLAN-WEBUI.md).
- Umgebungssuche mit Tabs für Blöcke und live gemeldete Item-Drops (Name, Anzahl, Entfernung, Filter und 📦-Kartenmarker). Blocksuche mit Registry-Autovervollständigung, X/Y/Z-Koordinaten, anklickbaren Kartenmarkern und Zielübernahme aus der Trefferliste.
- Persistente Draufsicht mit Botposition, leichtem historischem Nebel und Übersicht bis 448 × 448 Blöcke. X/Z-Zielauswahl per Klick oder Tastatur, Wegvorschau ohne Bewegung und laufende Restweg-Anzeige.
- Navigation mit normalem Gehtempo auf geraden, ebenen Abschnitten ohne Kante (Kurven auf sicherem Boden mit verringertem Tempo) und vorsichtigem Tempo an Kanten, über Vollblöcke, Halbstufen und richtungsabhängige Treppen. Sprünge auf einen Block Höhe und Abstiege bis einen Block. Erst der Start-Button bewegt den Bot.
- Türen und Zauntore: Geschlossene Holz- und Kupfertüren sowie Zauntore gelten bei der Wegplanung als begehbar (mit Umweg-Zuschlag von 3 Blöcken). Der Bot hält davor an, klickt sie einmal an und wartet bis zu 2 s auf die Öffnung durch den Server; bleibt sie zu, plant er für diese Navigation ohne sie neu. Türen, die er selbst geöffnet hat, schließt er nach dem Durchgehen wieder, außer ein anderer Spieler steht innerhalb von 2 Blöcken. Eisentüren und Falltüren bleiben Wände. Die Vorschau zeigt Wege durch Türen, öffnet aber nichts. `OPEN_DOORS=off` behandelt geschlossene Türen wieder als Wand.
- Eigener Skin per Upload (PNG 64×64 oder 64×32, Classic oder Slim), gespeichert in `data/skin.json`. Er wird beim Verbinden gesendet und gilt daher erst nach dem nächsten Verbinden; die Oberfläche bietet dafür „Jetzt neu verbinden“.
- Chatbefehle: Eine Chat- oder Flüsternachricht, die mit dem Bot-Namen beginnt (optional mit `@` davor und `,`/`:` danach, Groß-/Kleinschreibung egal), ist ein Befehl. `Name hallo` grüßt den Absender, `Name go <Wegpunkt>` läuft zu einem gespeicherten Ort der aktuellen Dimension (exakter Name, sonst eindeutiger Anfang), `Name come` läuft bis etwa zwei Blöcke an den sichtbaren Absender heran, `Name find <Block>` nennt den nächsten Fundort vom Absender aus (`minecraft:` wird ergänzt), `Name inventory` (kurz `inv`) nennt die Gegenstände im Inventar des Bots (Summen je Item, höchstens 8), `Name give <Item> [Anzahl]` läuft wie `come` zum Absender und wirft ihm das Item zu (Kurz- oder Vollname, sonst eindeutiger Anfang; ohne Anzahl alles davon; steht der Absender danach mehr als 4 Blöcke entfernt, behält der Bot die Sachen), `Name put <Item> [Anzahl]` legt das Item in die nächste Kiste (ohne Anzahl alles davon; `Name put all` legt das ganze Inventar ab), `Name get <Item> [Anzahl]` holt es aus Kisten (der Name wird gegen den Kisteninhalt aufgelöst, ohne Anzahl alles davon), `Name stop` hält an und beendet auch einen Kistengang. Als Kiste zählen Truhe, Redstone-Truhe und alle Kupfertruhen (keine Endertruhe, Fässer oder Shulker-Kisten); gesucht wird vom Bot aus, entfernte Kisten läuft er an. Ist eine Kiste voll (bzw. fehlt das Item), meldet er das und versucht die nächste, höchstens 5 Kisten; am Ende nennt er, was der Server bestätigt hat, und bleibt an der letzten Kiste stehen. Ziele müssen im geladenen Radius (`CHUNK_RADIUS` × 16 Blöcke) liegen. Antworten gehen in den öffentlichen Chat, ein Spieler kann höchstens alle 2 s einen Befehl geben. Ankunft, Fehlschlag oder Abbruch einer per Chat gestarteten Navigation meldet der Bot im Chat. `CHAT_COMMANDS=off` schaltet die Auswertung ab; jeder Spieler auf dem Server kann sonst Befehle geben.
- Collector: `Name collect` sammelt alle Drops, `Name collect <Item>` nur exakt dieses Item (`minecraft:` optional), `Name collect off` beendet den Job. Auch in der UI mit Ankerwahl (Bot-Position oder Wegpunkt) und Itemfilter. Horizontaler Radius wie beim Farmen: `min(24, CHUNK_RADIUS × 16 − 16)` Blöcke; keine Höhengrenze, nur sichere bekannte Wege. Nach der Runde kehrt er zum Anker zurück und wartet auf neue Drops. Eine Sammelbilanz nennt die aufgenommenen Mengen je Item im Chat und im UI-Status; leere Runden bleiben stumm. Unerreichbare oder erfolglos angelaufene Drops werden nach 30 Sekunden erneut versucht. Bei vollem Inventar wartet er am Anker auf freien Platz, ohne einzulagern. Farm und Collector schließen sich aus. Manuelle Chat-Aufträge pausieren für 60 Sekunden; UI-Navigation und Stopp beenden den Job. Reconnect setzt fort, Prozessneustart startet ausgeschaltet. Die Suche kennt ausschließlich vom Server gemeldete Drops; Sammeln beim Vorbeigehen kann auch andere Items aufnehmen.
- Fehlende Chunkspalten werden nachgeladen; neue Weltdaten, Chunkwechsel und Ankunft aktualisieren die Karte.

Geprüft gegen Bedrock **1.26.65 / Protokoll 2225**, mit Datenversion **1.26.60** und den enthaltenen Paketpatches. Kein Server- oder Welt-Downgrade erforderlich. Das ist keine allgemeine Versions- oder Add-on-Garantie.

## Konfiguration

Versioniert werden nur die Beispiele. Ausgefüllte Dateien sind durch `.gitignore` und `.dockerignore` ausgeschlossen:

| Beispiel | Lokale Datei | Zweck |
| --- | --- | --- |
| `.env.example` | `.env` | GHCR-Image, Minecraft-Verbindung, Bot und lokale Weboberfläche/Compose |
| `config/arcane.env.example` | `config/arcane.env` | Erzeugung des Arcane-Deployment-Pakets |
| `config/smoke.env.example` | `config/smoke.env` | Webadresse und Dauer bewusst gestarteter Smoke-Tests |

```sh
cp .env.example .env
cp config/arcane.env.example config/arcane.env
cp config/smoke.env.example config/smoke.env
```

Anschließend die lokalen Dateien bearbeiten. `192.0.2.10` ist eine neutrale Dokumentationsadresse und muss ersetzt werden. `BEDROCK_VERSION` bezeichnet die Daten-/Protokollversion, nicht die Patchversion des Servers. `BEDROCK_ICE_HOST` bleibt leer, sofern keine Docker-private ICE-Adresse umgeschrieben werden muss; andernfalls die tatsächlich erreichbare Server-IP setzen.

In einer lokal vorbereiteten Kopie können diese Dateien bereits ausgefüllt vorliegen. Sie gehören weder in einen Commit noch in einen ungefilterten Ordner-Upload. Für eine zweite gleichzeitig gestartete Instanz einen anderen `BOT_NAME` wählen: Der Name bestimmt die stabile Offline-Spieleridentität.

## Lokal starten

Voraussetzungen: Node.js 24 und pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
node --env-file=.env dist/main.js
```

Die Weboberfläche bindet standardmäßig an `127.0.0.1:3000`. `.env` wird nur mit `--env-file` geladen; `pnpm start` verwendet die vorhandene Prozessumgebung.

Neben der Überschrift steht die Version aus `src/ui/version.txt`, zum Beispiel `@0.1.0`. Für einen neuen Stand die Nummer in dieser Datei ändern. `pnpm build` kopiert sie nach `dist/ui/version.txt`; Docker und die Arcane-Vorbereitung übernehmen sie ebenfalls. Die Anzeige aktualisiert sich nach Build und Neustart. Die Nummer wird manuell gepflegt.

## Docker und Arcane

Die Compose-Datei verwendet das veröffentlichte GHCR-Image. In `.env` zuerst die vollständige Adresse des eigenen Pakets setzen, beispielsweise:

```dotenv
BOT_IMAGE=ghcr.io/dein-account/dein-repo:latest
```

Alternativ einen veröffentlichten Commit-Tag `sha-<vollständiger-commit-sha>` verwenden. Account- und Repositoryname müssen zur GitHub Action passen und kleingeschrieben sein. Der erste erfolgreiche `main`-Build muss das Image bereits veröffentlicht haben. Bei einem privaten GHCR-Paket zuerst `docker login ghcr.io` ausführen.

```sh
docker compose config --quiet
docker compose pull
docker compose up -d
```

Image-Adresse, Minecraft-Verbindung, Botname, Chunkradius und Host-Portfreigabe werden weiterhin aus der `.env` neben `compose.yaml` interpoliert. `BOT_IMAGE` ist erforderlich; es gibt keinen fest eingebauten Repositorynamen und keinen lokalen Compose-Build. Für Updates erneut `docker compose pull` und `docker compose up -d` ausführen. Docker und Compose genügen dafür; Node.js und pnpm werden nur für lokale Quellcode-Entwicklung benötigt.

Compose startet nur den Bot und erhält dessen Server-Key-Pin in einem Volume. `WEB_BIND` und `WEB_PORT` steuern die Host-Freigabe; der Listener im Container bleibt absichtlich auf `0.0.0.0:3000`. Die Standardveröffentlichung bleibt auf Loopback begrenzt. Die vorhandene Minecraft-Welt wird nicht verändert. Für den Offline-Login muss der eigene Server entsprechend konfiguriert sein.

```sh
pnpm prepare:arcane
```

Dieser Befehl liest `config/arcane.env` und erzeugt das ignorierte Verzeichnis `deploy/arcane/`. Es enthält aufgelöste Verbindungsangaben und darf nicht veröffentlicht werden. Den Ordner gezielt über die eigene Arcane-Installation bereitstellen. Der Webport wird dort zugeteilt. Ressourcenlimits: Bot 0,5 CPU / 256 MiB, Testservice 0,25 CPU / 128 MiB. Weder die Paketvorbereitung noch die Tests starten automatisch ein Deployment.

## Persistente Karte und Performance

Alle geladenen Oberflächen werden auch ohne Dashboard unter `data/maps/` gespeichert. Die Zuordnung erfolgt nach Serveradresse, `MAP_WORLD_ID` und Dimension. **Beim Weltreset oder Ersetzen der Welt `MAP_WORLD_ID` ändern**, damit alte und neue Oberflächen getrennt bleiben. Docker erhält die Daten im vorhandenen Volume. Speicherung erfolgt ungefähr alle fünf Sekunden und beim regulären Beenden; bei Absturz kann das letzte Intervall verloren gehen. Es gibt keine automatische Löschung.

Historische Flächen erhalten einen leichten hellen Nebel mit 16 % Deckkraft. Die Karte startet mit 112 × 112 Blöcken und lässt sich bis 448 × 448 Blöcke erweitern. Ziehen verschiebt, Mausrad und +/− zoomen, „Zum Bot“ aktiviert die Verfolgung. Unbekannte Daten bleiben unbekannt; Navigation, Vorschau und Blocksuche verwenden ausschließlich aktuelle Weltdaten.

Pixelpuffer, gecachte Blockfarben, getrennte Gelände-/Overlay-Ebenen und gebündelte Mausereignisse vermeiden unnötige Zeichenarbeit. Kachelfingerabdrücke und `If-None-Match` verhindern unveränderte Übertragungen. Vollständig unbekannte Kacheln werden ohne separaten Datenabruf übersprungen. Der Container-Healthcheck verwendet `node:http` bei unverändertem Prüftakt.

`/?measure=1` öffnet den zuschaltbaren Messmodus; die Messschleife startet erst per Schaltfläche. Details: [Karte](docs/KARTE.md), [Performancewerte und Grenzen](docs/KARTENPERFORMANCE.md).

## GitHub Actions und GHCR

`.github/workflows/docker-build.yml` verwendet das vorhandene Dockerfile auf einem GitHub-gehosteten Ubuntu-24.04-Runner:

- **Push auf `main`:** Image bauen und anschließend in GHCR veröffentlichen.
- **Pull Request:** ausschließlich den Dockerbuild prüfen, ohne Registry-Login und ohne Schreibrechte für Pakete.
- **Andere Pushes:** ausschließlich den Build prüfen.
- **Manueller Start über Actions:** ausschließlich den Build prüfen; auch bei ausgewähltem `main` wird dabei nichts veröffentlicht.

Der Publish-Job verwendet das automatisch bereitgestellte `GITHUB_TOKEN` mit `contents: read` und `packages: write`. Zusätzliche Registry-Secrets oder ausgefüllte Serverkonfigurationen sind nicht nötig. Der Paketname wird aus dem Repositorynamen abgeleitet und kleingeschrieben:

- `ghcr.io/<owner>/<repo>:latest`
- `ghcr.io/<owner>/<repo>:sha-<vollständiger-commit-sha>`

Beispiel nach erfolgreichem `main`-Lauf, mit eigenem Account- und Repositorynamen:

```sh
docker pull ghcr.io/dein-account/dein-repo:latest
```

Neue GHCR-Pakete sind standardmäßig privat. Für anonymen Download unter **Packages → Paket → Package settings → Change visibility → Public** die Paketsichtbarkeit anpassen; andernfalls ist ein Registry-Login nötig. Ein bereits vorhandenes Paket muss diesem Repository Schreibzugriff für Actions gewähren. Maßgeblich ist die [GitHub-Dokumentation zur Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

Das Image enthält nur den Build aus dem Repository; lokale `.env`-Dateien und ausgefüllte `config/*.env` bleiben ausgeschlossen. Es wird kein Deployment gestartet und kein Minecraft-Server verbunden. Der Build kompiliert TypeScript; die vollständige Testsuite läuft separat mit `pnpm test`. Das Runner-Image baut hier `linux/amd64`; ein ARM-Image ist nicht enthalten.

Nach Commit und Push des Repositories wird der Workflow wirksam. Ein tatsächlicher GitHub-/GHCR-Lauf wurde lokal nicht ausgeführt.

## Prüfungen

`pnpm test` baut TypeScript und führt `node:test`-Tests aus. Sie decken Transport, Weltmodell, Vorschau, Bewegung und Websteuerung ab. Die bereinigte Kopie wurde mit TypeScript-Build und 61 bestandenen Tests geprüft, einschließlich der Deployment-Konfiguration.

```sh
pnpm check:compatibility
node --env-file=.env --env-file=config/smoke.env scripts/probe-server.cjs
node --env-file=.env --env-file=config/smoke.env scripts/smoke-server.cjs
```

Der Kompatibilitätscheck ohne Serverumgebung arbeitet lokal und schreibt einen ignorierten Bericht. Probe und Smoke-Test verbinden sich mit dem konfigurierten echten Server. Bewegungs-Smoke-Tests bewegen einen echten Spieler; `scripts/smoke-speed.cjs` läuft eine gerade, ebene Strecke von 4–8 Blöcken hin und zurück und schreibt Tempo und Serverkorrekturen nach `data/speed-smoke-result.json`. `scripts/smoke-door.cjs` läuft mit `DOOR_TARGET=x,z` durch eine geschlossene Tür hin und zurück (`data/door-smoke-result.json`; Öffnen und Schließen stehen als `[nav]`-Zeilen im Bot-Log). `scripts/smoke-inventory.cjs` meldet sich als eigene Bot-Instanz an (den regulären Bot vorher stoppen, gleicher Name), protokolliert das gemeldete Inventar und wirft genau ein Item 2 Blöcke nach Süden ab: `SMOKE_GIVE=<Item>` oder das erste vorhandene (`data/inventory-smoke-result.json` mit den rohen Inventar- und `item_stack_response`-Paketen). Mit `SMOKE_WATCH=<Sekunden>` wirft es nichts ab und zeichnet stattdessen die Pakete auf, während ein Spieler dem Bot Items zuwirft. `scripts/smoke-chest.cjs` (ebenfalls eigene Bot-Instanz) sucht die nächste Kiste, läuft hin, öffnet sie, legt ein Item hinein und holt es zurück, mit allen Container-Paketen in `data/chest-smoke-result.json`; mit `SMOKE_MODE=commands` laufen stattdessen die Chatbefehle `put <Item> 1` und `get <Item> 1` (`SMOKE_ITEM`, sonst das erste Item; Antworten gehen in den öffentlichen Chat). `TERRAIN_TEST_PLAYER` nur für eine überprüfte, separate Testspieler-Instanz setzen.

## Grenzen und Sicherheit

Keine Anmeldung oder eigene TLS-Terminierung: Websteuerung und Offline-Minecraft-Verbindung gehören ins vertrauenswürdige Netz. Veröffentlichter Quellcode bedeutet keine Freigabe für öffentlichen Internetbetrieb. Signaturen, Server-Key-Pinning und DTLS-Prüfungen bleiben aktiv; einen geänderten Betreiber-Schlüssel unabhängig verifizieren.

Unbekannte oder gefährliche Flächen sind nicht begehbar. Keine Lückensprünge, Zwei-Block-Sprünge, allgemeines Klettern oder Schwimmen. Statuseffekte, Rückstoß, spezielle Bewegungsblöcke und Entitätskollisionen sind nicht allgemein simuliert. Stopp beendet Vortrieb; eine laufende Sprung-/Fallbewegung endet bei der Landung. Nach Tod ist eine manuelle Wiederanmeldung nötig. Dauerbetrieb und Pflanzenwachstum müssen am eigenen Server geprüft werden.

## Weitere Dokumentation

- [Architektur und Schnittstellen](docs/ARCHITEKTUR.md)
- [Persistente Karte, Nebel und Übersicht](docs/KARTE.md)
- [Kartenperformance und Messmodus](docs/KARTENPERFORMANCE.md)
- [Kompatibilität und Paketpatches](docs/KOMPATIBILITAET.md)
- [Veröffentlichungsumfang und Lizenzstatus](docs/VEROEFFENTLICHUNG.md)
- [Contributor Guide](AGENTS.md)

Eine Projektlizenz wurde noch nicht festgelegt. Die MIT-Lizenzen direkter Abhängigkeiten legen keine Lizenz für dieses Projekt fest.
