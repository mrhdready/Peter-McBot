# MC Bot

Minecraft-Bedrock-Bot mit Websteuerung für einen vorhandenen Server. TypeScript und Node.js 24, ein Prozess mit getrennten Modulen für Bot, Weltmodell und HTTP/SSE.

## Funktionen

- AFK-Verbindung über HTTP-NetherNet; manuelles Verbinden und Trennen, Login-Timeout und begrenzte Wiederverbindung. Keine automatische Verbindung beim Prozessstart.
- Zentraler Welt-State und 20-Hz-Herzschlag; Chunkdecodierung im Worker. Bekannte und unbekannte Weltdaten bleiben unterscheidbar.
- Weboberfläche mit der Karte im Zentrum und einer Seitenleiste (Ziel & Navigation, Bot, Blocksuche, Hilfe). Zielwahl und Start ohne Scrollen; auf schmalen Bildschirmen bleibt eine Navigationsleiste unten fixiert. Manuelle Prüfschritte: [docs/TESTPLAN-WEBUI.md](docs/TESTPLAN-WEBUI.md).
- Blocksuche mit Registry-Autovervollständigung, X/Y/Z-Koordinaten, anklickbaren Kartenmarkern und Zielübernahme aus der Trefferliste.
- Persistente Draufsicht mit Botposition, leichtem historischem Nebel und Übersicht bis 448 × 448 Blöcke. X/Z-Zielauswahl per Klick oder Tastatur, Wegvorschau ohne Bewegung und laufende Restweg-Anzeige.
- Langsame Navigation über Vollblöcke, Halbstufen und richtungsabhängige Treppen. Sprünge auf einen Block Höhe und Abstiege bis einen Block. Erst der Start-Button bewegt den Bot.
- Eigener Skin per Upload (PNG 64×64 oder 64×32, Classic oder Slim), gespeichert in `data/skin.json`. Er wird beim Verbinden gesendet und gilt daher erst nach dem nächsten Verbinden; die Oberfläche bietet dafür „Jetzt neu verbinden“.
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

Der Kompatibilitätscheck ohne Serverumgebung arbeitet lokal und schreibt einen ignorierten Bericht. Probe und Smoke-Test verbinden sich mit dem konfigurierten echten Server. Bewegungs-Smoke-Tests bewegen einen echten Spieler. `TERRAIN_TEST_PLAYER` nur für eine überprüfte, separate Testspieler-Instanz setzen.

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
