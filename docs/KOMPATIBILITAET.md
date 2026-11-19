# Kompatibilität und Paketpatches

Geprüfte Kombination: Bedrock Dedicated Server 1.26.65, Netzwerkprotokoll 2225, Datenversion 1.26.60. Diese Datenversion ist kein Server-Downgrade. Abweichende Protokollnummern werden abgelehnt; weitere Releases oder Add-ons sind nicht allgemein abgenommen.

## Festgelegte Pakete

| Paket | Version |
| --- | --- |
| bedrock-protocol | 3.61.0 |
| prismarine-chunk | 1.41.0 |
| prismarine-registry | 1.12.0 |

`pnpm-workspace.yaml` bindet zwei versionierte Patches ein. Zusammen mit dem Lockfile erhalten:

- `bedrock-protocol`: HTTP-NetherNet-Signalisierung, vollständige ICE-Angebote, signierte Offline-Identität, geprüfte Serverantwort und Abbruchbehandlung.
- `prismarine-chunk`: Bedrock-1.26-Loader und gehashte Runtime-ID-Auflösung auch für einheitliche Subchunks.

Der geprüfte NetherNet-Pfad verwendet reines JavaScript; Installationsskripte bleiben deaktiviert. Legacy-RakNet und Xbox-/Online-Authentifizierung sind nicht Bestandteil der Live-Abnahme.

## Docker und Serververtrauen

Wenn der Server eine Docker-private ICE-Adresse nennt, kann `BEDROCK_ICE_HOST` nur die Kandidatenadresse ersetzen. Port und geprüfte DTLS-Fingerprints bleiben erhalten. Der angekündigte UDP-Port muss erreichbar sein. Beispielwerte stehen ausschließlich in den Konfigurationsvorlagen; eigene Adressen gehören in die ignorierten Dateien.

Ein geprüfter Betreiber-Schlüssel wird unter `data/server-key.sha256` gepinnt. Bei geändertem Schlüssel schlägt die Verbindung fehl. Den Wechsel unabhängig prüfen; die Vertrauensprüfung nicht abschalten. `BOT_NAME` bestimmt die stabile Offline-Spieleridentität und damit die gespeicherte Spielerposition.

## Prüfungsumfang

Automatisierte Tests prüfen tatsächliche Paketserialisierung, einen bereinigten erfassten Subchunk, Registry-Kollisionen, Vorschau-Isolation, Navigation, Chunkwechsel und Websteuerung. Der Container-Smoke-Test prüft zusätzlich echte Verbindung, Spawn, HTTP/SSE, Karte, Suche, Wiederverbindung und Vorschau ohne Bewegung.

Die Entwicklung wurde am echten Server mit Ein-Block-Aufstieg und -Abstieg sowie Hin-/Rückwegen über Chunkgrenzen geprüft. Treppen und Halbstufen sind über kontrollierte Kollisionsdaten und echte Registry-Zustände getestet; ein gebauter Live-Parcours wurde nicht verwendet. Langfristiges Pflanzenwachstum ist nicht abschließend nachgewiesen. Die mitgelieferte Testfixture enthält Versionsmetadaten und Blockdaten, keine Identitätstoken oder absoluten X/Z-Koordinaten.

Lokale Prüfung: `pnpm check:compatibility`. Das Ergebnis wird in der ignorierten Datei `compatibility-result.json` gespeichert. Verbindungstests sind getrennt davon bewusst mit der eigenen Konfiguration auszuführen.
