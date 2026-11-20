# 2026-11-20: Neugestaltung der Weboberfläche

**Anlass:** Die einspaltige Seite war unübersichtlich. Nach einer Zielwahl auf der Karte musste man weit scrollen, um die Navigation zu starten.

**Änderungen**
- Die UI liegt in `src/ui/` (`index.html`, `style.css`, `app.js`). `pnpm build` kopiert sie nach `dist/ui/`, `web.ts` liest sie beim Start und bettet Stil und Skript inline ein. `pnpm test` ruft jetzt `pnpm build` auf.
- Layout: Die Karte füllt die Hauptfläche, rechts eine Seitenleiste mit 24rem (Ziel & Navigation, Bot, Blocksuche, Hilfe). Die Seite ist auf die Fensterhöhe begrenzt, die Seitenleiste scrollt intern. Unter 900px wird gestapelt, und das Navigationsformular ist unten fixiert.
- Kartensteuerung und Legende sind Overlays. Die Erklärtexte stehen in der aufklappbaren „Hilfe“.
- Ein Umschalt-Button `#connection-toggle` ersetzt `#connect` und `#disconnect`. Der Status erscheint als Badge mit deutschen Labels.
- In der Trefferliste übernimmt der Button „Ziel“ X/Z als Navigationsziel, ohne Bewegung.
- Das Messpanel (`/?measure=1`) hängt sich an `#sidebar`.

**Entscheidungen**
- Bewusst kein Framework und kein Bundler: Für die Leistung zählt das Canvas-Rendering, und der Test-Harness nutzt genau ein Inline-Script mit Fake-DOM.
- IDs, Tastaturbedienung und ARIA bleiben erhalten. Das Farbschema bleibt dunkel, mit CSS-Variablen.

**Offen:** Der manuelle Test nach [TESTPLAN-WEBUI.md](../TESTPLAN-WEBUI.md) läuft auf einer Umgebung mit Node 24. Lokal konnten weder `tsc` noch die Tests ausgeführt werden.
