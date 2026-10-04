## Wat

De landingspagina `/` is herbouwd als showcase in Vis-design (M43, PBI-178, ST-1629). Het verhaal is de pipeline van idee tot geverifieerde pull request, met als bewijs dat Scrum4Me met Scrum4Me is gebouwd.

Secties: hero, bewijsstrook, pipeline in vijf stappen, regie via iPhone en Watch, standaarden, rond de sprint, architectuur, en de referentie-inhoud (quickstart, gebruikersgids, Scrum-uitleg, REST API) als ingeklapte accordeons.

## Hoe

- `app/page.tsx` is een dunne shell; copy (EN/NL) staat in `lib/landing/copy.ts`, elke sectie is een servercomponent in `components/landing/`.
- Beelden staan in `public/landing/` (WebP, licht en donker); `public/screenshots/` is verwijderd.
- De webbeelden komen uit een fictieve demo-dataset: `scripts/landing/seed-demo.ts` (weigert elke database waarvan de naam niet op `_landing` eindigt) en `scripts/landing/capture.mjs`. Zie `scripts/README.md`.
- Bewijscijfers zijn statisch in `lib/landing/proof.ts`, peildatum 2026-10-04: 145 sprints CLOSED, 1788 taken DONE, 805 ClaudeJobs DONE, 315 productdocs, 316 merge-commits op main.
- Een anker (`/#api`) opent zijn accordeon via een kleine client-hook; de accordeons zelf zijn native `<details>`.

## Afwijkingen van het plan

- Hero toont de backlog in plaats van het sprintscherm.
- Tweede heroknop is Registreren in plaats van een tweede loginlink.
- Bewijsstrook toont afgeronde taken in plaats van "oppervlakken".
- Het beeld van de regel-dialoog in de Hub is niet gebruikt.

## Verificatie

- `npm run verify` groen: 377 testbestanden, 3931 tests.
- In de browser gecontroleerd: EN/NL, licht/donker, `/#api`, geen kapotte beelden, geen console-fouten.
- `npm run build` is lokaal niet gedraaid (worktree); CI moet die bewijzen.
- iPhone- en Watch-beelden zijn nog de M42-weergaveproeven.

Plan: `docs/plans/M43-landingspagina-showcase.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)

