Het Ops-dashboard krijgt het Vis-thema dat Scrum4Me, scrum4me-workers en de Media-Organizer al hebben: warm papier, inkt-tekst, in licht en donker.

## Wat verandert
- `app/styles/theme.css` is een bytegelijke kopie van `app/styles/theme.css` uit Scrum4Me (sha256 `e01085a3…947dd22d`); de contrasttest is ongewijzigd overgenomen (761 gevallen) en staat in de CI-groep `base`.
- Public Sans, Source Serif 4 en Geist Mono; themakleur en manifest op `#fdf9f4`.
- Ruwe paletklassen van 492 naar 0; alle `dark:`-paren met ruwe kleuren vervallen. Statuskleuren houden hun betekenis (success, warning, error, info).
- Knoppen in pilvorm. De 85 losse knoppen blijven `<button>` (refs, `type` en `disabled`-gedrag in bevestigingsdialogen ongemoeid) en krijgen de pil via hun klassen.
- Ember alleen op inloggen en koppelen; alles wat iets op een server start of wijzigt blijft inkt (`docs/m44-ember-lijst.md`).
- Invoervelden met `border-control-border`, onderstreepte tekstlinks.
- Het terminalvenster en drie codevakken (auditlog-uitvoer, Caddyfile-weergave, configuratievoorvertoning) dragen een vaste `dark`-klasse.
- `docs/design/styling.md` en een stylingregel in `AGENTS.md`.

Alleen klassen, lettertypen, twee kleurwaarden en documentatie; geen logica gewijzigd.

## Verificatie
- `npm run typecheck` en `npm run build` groen.
- `npm test` lokaal op macOS, op de stand vóór de knop- en documentatiecommits: 5.555 geslaagd, 19 mislukt in 2 bestanden (`db-access-policy-bundle-flow` mist `flock`, `caddy-write-wrapper` verwacht Linux). De run op de eindstand liep nog bij het openen van deze PR; CI is leidend.
- Paletcontrole over `app components lib`: 0.
- Routecontrole in de browser met een lokale proefdatabase en een nagebootste ops-agent met vaste voorbeelddata; er is geen echte server aangesproken en niets uitgevoerd. Elf routes bekeken, vier ook in donker: `docs/m44-bewijs/increment-2/controle.md`. JP keurde de proef (increment 0) goed op 2026-10-04.

## Niet in de browser bekeken
Detailpagina's (unit, container, repo, auditrun), control-room, releases, network, mirror, worker-insights, de overige flowpagina's, het terminalvenster met echte uitvoer en de copilot-lade. Ze zijn wel vertaald; de volledige lijst staat in `controle.md`.

## Opgemerkt, niet door deze wijziging
- Hydratiefout op `/systemd` en `/docker`: de tijd bij "updated" wordt op de server anders opgemaakt dan in de browser.
- Doorstuurlus tussen `/login` en `/` met een sessiecookie waarvan de sessie niet meer bestaat.

Plan: Scrum4Me `docs/plans/M44-vis-ops-en-media.md`. PBI-24, ST-073, ST-074, T-193–T-203.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
