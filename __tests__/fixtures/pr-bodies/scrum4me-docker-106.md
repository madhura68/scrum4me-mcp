## Waarom

WARNING uit de review van scrum4me-docker#105: de reset-test van de inspect-grens gebruikte echte timers met maar ~25 ms marge tot de grens van 50 ms. Onder CPU-belasting kon een vertraagde inspect de juiste implementatie toch `uncertain` laten geven, zodat de test flaky zou worden.

## Wat

Een bestuurbare klok via `vi.spyOn(Date,'now')`: elke inspect zet de klok 30 ms verder, los van de belasting van de machine. Elke `unknown`-episode duurt 30 ms (onder de 50). Zonder reset zou de tweede episode 120 ms na de eerste vallen (boven de 50). De test wacht niet meer echt.

## Verificatie

- Supervisor-suite: 62 van 62.
- Mutatie zonder de reset na `running`: de test faalt.
- 10 keer achter elkaar gedraaid: 10 van 10 groen.

Alleen een test.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

