## Waarom (T-1972, review scrum4me-docker#103)

De supervisor legt de usage van een poging vast in zijn journal, maar herstelt een poging die zijn submit verloor via `POST /attempts/recovery/result`. Die route kende `usage` niet, waardoor de usage op dat pad verloren ging (de blokkerende bevinding op scrum4me-docker#103).

## Wat

- `POST /attempts/recovery/result` accepteert een optioneel `usage` (`{binding,result,usage?}`), net als `/attempts/result`. De route parseert het niet zelf.
- `nonLaunchRecovery().submitResult(binding,result,usage)` geeft het door via `acceptHistoricalResult`. Daarna geldt dezelfde domeinlogica als in scrum4me-mcp#179:
  - een vers resultaat schrijft de usage in de afrondende transactie;
  - een laat resultaat van dezelfde poging schrijft hem eenmalig, en het canonieke resultaat blijft ongemoeid.
- README: de herstelroute staat erin, en het bredere late-result-gedrag is beschreven: annulering bij de stop (ook tussen de twee transacties) en operatorherstel met `close_failed` of `close_cancelled`. Dit pakt de WARNING uit de review van #179 op met documentatie en tests, in plaats van het gedrag te beperken. Een supervisor dient alleen zijn ene vastgelegde resultaat opnieuw in, dus de late usage is altijd die van de run zelf.

## Verificatie

- RED: de nieuwe tests voor de herstelroute (vers resultaat, en laat resultaat na annulering) faalden met lege usagekolommen.
- `vitest.dispatch.config.ts` op een wegwerp-Postgres: **288 van 288** (recovery-suite 19 van 19, waarvan 3 nieuw, onder meer late result na `close_failed`).
- `npx vitest run`: 2032 geslaagd; `tsc --noEmit` is schoon.

**Uitrolvolgorde:** deze service gaat live vóór een supervisor die `usage` via de herstelroute meestuurt (scrum4me-docker#103).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

