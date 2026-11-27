# Veröffentlichungsumfang und Lizenzstatus

Diese Kopie enthält Quellcode, Tests, Paketpatches, Konfigurationsbeispiele und allgemeine Dokumentation. Interne Betriebsberichte, Deployment-Aufträge und -Adressen, Laufzeitdaten, installierte Abhängigkeiten, Kompilate und frühere Git-Metadaten wurden nicht übernommen. Technische Versions- und Testangaben bleiben erhalten; sie beschreiben den geprüften Umfang und keine allgemeine Produktionsgarantie.

## Lokale Konfiguration

Nur `.env.example` und `config/*.env.example` werden versioniert. Die ausgefüllten `.env` und `config/smoke.env` bleiben durch Ignore-Regeln ausgeschlossen. Dasselbe gilt für Logs und Identitätsdaten. Ignore-Regeln schützen keinen ungefilterten ZIP-Upload.

Für einen Quellcode-Export ausschließlich die versionierten Dateien verwenden. Ein vorbereitetes Quellcode-Archiv enthält keine ausgefüllten Konfigurationen und keine Git-Metadaten. Vor einem Commit `git status --short` und den vorgesehenen Diff prüfen. Keine Verbindung oder Bereitstellung wird durch diese Kopie automatisch gestartet.

## Testfixture

Der erfasste Subchunk in `test/fixtures/` ist eine benötigte Regressionstest-Datei mit Blockdaten und Versionsmetadaten. Er enthält keine Identitätstoken oder absoluten X/Z-Koordinaten. Neue Aufnahmen müssen gezielt geprüft werden; vollständige Netzwerkprotokolle und Laufzeitberichte gehören nicht ins Repository.

## Lizenz

Eine Projektlizenz wurde noch nicht festgelegt. Es wurde keine Lizenz stellvertretend ausgewählt. Die direkten Abhängigkeiten bedrock-protocol, prismarine-chunk und prismarine-registry deklarieren MIT; ihre Hinweise bei Weitergabe erhalten. Daraus folgt keine automatische Lizenz für den eigenen Quellcode. Vor einer Freigabe zur Nachnutzung die gewünschte Projektlizenz ergänzen. Eine vollständige Lizenzprüfung transitiver Pakete und Containerbestandteile steht aus.

`private: true` im Paketmanifest verhindert versehentliche npm-Veröffentlichungen. Es ist kein Zugriffsschutz für ein Git-Repository. Das Webinterface besitzt keine Anmeldung oder eigene TLS-Terminierung und bleibt für ein vertrauenswürdiges Netz vorgesehen.

## Prüfung der Kopie

TypeScript-Build und 61 Tests bestanden. Die synchronisierte Fassung enthält Kartenpersistenz, Pixelraster-Optimierung, Messmodus, schlanken Healthcheck, hellen historischen Nebel und Übersicht bis 448 × 448 Blöcke. Die Prüfung verwendete die bereits installierten, versionsgleichen und gepatchten Abhängigkeiten; eine zusätzliche Neuinstallation aus dem Netz wurde nicht durchgeführt. Persönliche Adressen, lokale Dateipfade, bekannte Betreiber-Pins und interne Auftragskennungen wurden im vorgesehenen Quellcode-Umfang nicht gefunden. Die ausgefüllten Konfigurationen sind von Git und dem Quellcode-Archiv ausgeschlossen. Die Ursprungsversion und der laufende Bot wurden dafür nicht geändert oder neu bereitgestellt. Es wurde nichts auf einen Git-Server hochgeladen.
