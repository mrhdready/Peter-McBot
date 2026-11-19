# BDS-Subchunk als Regressionstest

`bedrock-1.26.65-subchunk.json` enthält einen tatsächlich empfangenen Subchunk vom vorhandenen Bedrock-Server 1.26.65, Netzwerkprotokoll 2225. Er wurde am 18.11.2026 per Offline-NetherNet-Verbindung mit deaktiviertem Client-Blobcache angefordert.

Die Datei enthält ausschließlich Versionsangaben, Hashmodus, Subchunk-Y und die Base64-Nutzdaten. Identitätstoken, SDP, Spielerdaten und absolute X/Z-Koordinaten sind nicht enthalten.

Der Test benutzt die Registry-Daten 1.26.60, deren Protokollnummer zum Server passt. Die Registry erzeugt die gehashten Runtime-ID-Zuordnungen über `handleStartGame`. Der gepatchte Chunkloader behält `majorVersion=1.26` bei und verwendet das weiterhin passende Subchunk-v9-Format.

Die beobachtete Blockverteilung steht im Regressionstest. Sie belegt, dass alle 4096 Zellen dieses Pakets zu bekannten Blockzuständen aufgelöst werden. Sie ist kein unabhängiger Sichtvergleich der Welt und kein Nachweis für alle Blockzustände oder Add-ons.

Erneutes Erfassen ist eine bewusste Änderung der Testdatei:

```sh
BEDROCK_HOST=192.0.2.10 CAPTURE_CHUNKS=1 node scripts/probe-server.cjs
```

Bei einer neuen Aufnahme müssen die erwarteten Verteilungen nach Prüfung angepasst werden.
