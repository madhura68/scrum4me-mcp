# De nieuwe `~/.claude/rules/s4m-queue.md` (fase 3, taak 7)

> **STATUS: revisie 3, actief op mac sinds 2026-07-27** — sha256 `277b6354…`,
> 5469 bytes, 34 regels. Back-up van de oorspronkelijke versie staat op mac en
> scrum4me-server als `~/.claude/rules/s4m-queue.md.bak-voor-fase3`; **max2 heeft
> er geen**, want daar bestond vóór 2026-07-26 geen rules-file en geen
> `~/.claude/rules/`-map. Dit document is de bron voor de sync en hoort
> byte-identiek te zijn aan het actieve bestand.
>
> Revisiegeschiedenis: `4843c637` (26-07, eerste uitrol) → `2b5862d1` (26-07,
> `scrum4me-server:codex` toegevoegd) → `277b6354` (27-07, revisie 3).
>
> **Correctie: `s4m-rules-apply` bestaat wél.** Een eerdere versie van dit blok
> beweerde van niet, op grond van `command -v` dat niets vond. Dat was fout, en de
> reden dat hij onvindbaar was is veelzeggend: de bin was kapot. Bron staat in
> `s4m-queue/src/rules-apply.ts`, met een bin-entry in `package.json` en een symlink
> in `/opt/homebrew/bin`; hij consumeert rules-sync-berichten uit de queue (PBI-9).
> Op 2026-07-26 wiste een `cp -R` van `dist/` de executable-bit van alle drie de
> binaries, en alleen `cli.js` werd toen gerepareerd — de enige die getest was.
> Sindsdien hersteld.
>
> **Hij kent kimi niet, en dat is een openstaande beslissing.** `s4m-rules-apply`
> heeft een eigen allowlist die níét van `MODELS` is afgeleid: hij weigert letterlijk
> met `vereist --as claude|codex`. Bovendien routeert `targetPath()` alles-behalve-codex
> naar `~/.claude/rules`, dus kimi er blind aan toevoegen zou zijn regelbestanden in
> Claude's map laten belanden; een `~/.kimi/rules`-conventie bestaat niet. Zolang die
> vraag openstaat gaat de distributie handmatig: inhoud plus sha256 als queue-taak naar
> elke host, die zelf schrijft en verifieert.

## Waarom het wachtte, en wat de activering blokkeerde

De inhoud verwijst agents primair naar de MCP-tools `queue_push`, `queue_wait_reply`,
`queue_next`, `queue_done`, `queue_fail`, `queue_status` en `queue_list`. Zolang de
draaiende MCP-server die niet aanbood, wees elke trigger naar een niet-bestaande tool.

Het activeren kostte drie stappen die elk apart misgingen, en dat is het bewaren waard:

1. **De MCP draait niet uit deze repo** maar uit een aparte checkout,
   `~/Development/scrum4me-mcp-stable` (zie `~/.claude.json` → `mcpServers.scrum4me`).
   Die stond 100 commits achter; herstarten alleen veranderde niets.
2. **Identiteit ontbrak.** De queue-tools lezen `S4M_SERVER` én `S4M_MODEL`. De eerste
   stond in `~/.zshenv`, de tweede bestond nergens. Beide horen in het `env`-blok van
   de MCP-config, niet in de shell — het gespawnde proces erft die niet betrouwbaar.
3. **De gegenereerde Prisma-schema was stil kapot.** `npm install` draaide zijn
   postinstall (`gen-schema.sh`) terwijl de submodule `vendor/scrum4me-shared` nog op
   een verkeerde commit stond. Resultaat: 37 in plaats van 39 modellen, precies
   `AgentMessage` en `AgentMessageArchive` weg. De server zou schoon starten, alle
   zeven tools registreren, en pas bij de eerste aanroep crashen op een undefined
   `prisma.agentMessage`. De submodule achteraf goedzetten repareert dat niet — de
   generatie moet daarna opnieuw. Controle die dit vangt:
   `git diff --stat prisma/schema.prisma` moet leeg zijn.

Geverifieerd is niet de tool-lijst maar een echte aanroep: `queue_status` met een
onbekend id gaf `QUEUE_NOT_FOUND`, wat registratie, identiteit, Prisma-delegate en
DB-verbinding in één klap aantoont. Een tool-lijst had er bij alle drie de defecten
hierboven gezond uitgezien.

## De voorwaarden die golden

1. ✅ Fase 2 restant gemerged (PR #98 — `queue_done` t/m de integratietests).
2. ✅ Fase 3 gemerged (lease-refresh, sweep, bootstrap-wiring, CLI-pariteit).
3. ✅ (mac) De MCP-server op de host herstart, zodat `registerQueueTools` de tools
   daadwerkelijk registreert. **Verifieer met een echte tool-aanroep, niet met een
   tool-listing** — zie hierboven waarom die laatste niets bewijst.
4. ⬜ Voor `inbox --in-reply-to` uit de CLI-fallback-sectie: `npm run build` in
   `s4m-queue` plus herinstallatie van de globale bin. Op mac gedaan (dat is een
   `npm link` naar de dev-checkout, dus: `dist/` bouwen en `chmod +x dist/cli.js`);
   scrum4me-server en max2 staan nog open (fase-1-draaiboek §4.4 stap 5).

## Waarom een rules-file alleen niet genoeg is

`max2` gebruikte bij de rollout-check de CLI in plaats van de MCP-tools. De voor de hand
liggende verklaring — "de oude rules-file schreef de CLI voor" — bleek **onjuist**: op die
host bestond helemaal geen rules-file. De reflex kwam uit een Claude Code-**memory-bestand**
onder `~/.claude/projects/<project>/memory/`, dat een eerdere sessie daar had achtergelaten.

Dat is een derde distributiekanaal naast de rules-file en de tool-descriptions, en het is
per project én per host. Reken er dus niet op dat één gesyncte rules-file het gedrag op een
host bepaalt; controleer bij onverwacht routegedrag ook de memory-bestanden daar.

Ter illustratie van de drift die dit oplevert: de oude rules-file was op `scrum4me-server`
2459 bytes / 33 regels (29 mei), op mac 3709 bytes / 45 regels, en op `max2` afwezig — drie
verschillende toestanden van hetzelfde document.

## Voorgestelde inhoud

~~~markdown
# Cross-agent communicatie (s4m-queue)

Berichten-queue tussen hosts `mac`, `scrum4me-server`, `max2` en participants `claude`, `codex`, `jp` (mens), op de scrum4me-DB. Agents (claude, codex) gebruiken de **MCP-tools** van de `scrum4me` MCP; de `s4m-queue` CLI blijft voor jp (mens) en als fallback. MCP-identiteit = `S4M_SERVER` + `S4M_MODEL` uit de server-config (override per call via `as`); ontbreekt die → `QUEUE_IDENTITY_REQUIRED`.

**MCP-tools:** `queue_push · queue_wait_reply · queue_next · queue_done · queue_fail · queue_status · queue_list`. Admin (`requeue`, `cancel`, volledige `list`-varianten, cleanup) blijft CLI.

**Triggers** (gebruiker zegt → jij doet):
- "stuur dit naar <server / model / mac / max2 / jp>" → `queue_push {to, type, body, …}` — bewaar het teruggegeven `message_id`; dat is je handle voor het antwoord.
- "heb ik antwoord?" / wachten op een reply → `queue_wait_reply {message_ids: [...]}` met je eigen request-ids. Blokkerend (`wait_seconds: 300`) of niet-blokkerend (`wait_seconds: 0`, doorwerken en later checken). Timeout is géén fout: gewoon opnieuw aanroepen. De respons bevat álle beschikbare replies (elk met `in_reply_to`); verwijder beantwoorde ids uit volgende aanroepen. Gelezen replies zijn meteen ge-ackt (auto-ack) — nogmaals lezen kan altijd, zelfde inhoud.
- "werk de queue af" / "is er werk voor mij?" → `queue_next` (claim → uitvoeren binnen `meta.task.cwd` → `queue_done {message_id, reply, claim_token}`). Ontbreekt vereiste context → `queue_fail {message_id, error, claim_token}`, niet raden; daarna stoppen (stop-bij-eerste-fout).
- "is er al antwoord?" zonder te claimen → `queue_status {message_id}` (read-only, toont bericht + alle replies).
- "wat staat er open?" / **herstel na sessie-crash** → `queue_list` — vindt je uitstaande requests terug (`direction: 'sent'`); doe daarna gewoon `queue_wait_reply` op die ids. Niets raakt wees.

**Sturen:** `task` en `review_request` vereisen `meta.task`; via de MCP volstaan `cwd` + `objective`/`verification`/`response_format` — de tool leidt `repo` zelf af uit de cwd (lukt dat niet, geef `meta.repo` expliciet mee). `info` = data-vraag of ja/nee aan JP (geen meta). Antwoord-types: task→result, info→data, review_request→reviewed.

**Claims & leases:**
- `queue_next` geeft een `claim_token`; geef dat mee aan `queue_done`/`queue_fail`. De lease wordt automatisch ververst zolang dít MCP-proces leeft — geen agent-actie nodig, geen handmatige verlenging.
- **Verlopen-claim-protocol:** bij `QUEUE_CLAIM_EXPIRED` of `QUEUE_NOT_CLAIMER` is je claim verlopen (MCP-herstart, sweep-requeue) of door een ander overgenomen. **Gooi lokaal werk weg** — dien nooit resultaten van een verlopen claim alsnog in — en begin desgewenst opnieuw met `queue_next`.
- **Idempotentie-eis voor task-handlers:** schrijf taken zo dat dubbele uitvoering onschadelijk is (zelfde branch/PR hergebruiken, upserts, geen dubbele side-effects). Een requeue kan altijd tot een tweede uitvoering leiden; statusvalidatie voorkomt alleen dubbele *afronding*.
- Vastzittende claims herstellen automatisch: MCP-claims ~5 min na procesdood, CLI-claims na 4 h (`S4M_RECLAIM_DEFAULT`). **Wil je direct verder in plaats van wachten** — bijvoorbeeld na een MCP-herstart, waarbij je eigen claim meteen `QUEUE_CLAIM_EXPIRED` geeft terwijl de rij nog op `claimed` staat — dan is `s4m-queue requeue <id>` (CLI) de enige weg; er is geen MCP-equivalent. Anders ~5 min op de sweep wachten. **Deel daarom nooit een taak uit die zélf de MCP herstart zonder dit recept erbij**: die claim overleeft de herstart per definitie niet.

**Echt "seintje" nodig terwijl je doorwerkt?** Start de CLI als background-Bash-taak (source de env-file van jóuw host, zie CLI-fallback hieronder):

    source <env-file> && s4m-queue inbox --as <model> --wait --in-reply-to <id,...> --json

Die blokkeert tot er een reply op jóuw requests binnenkomt (correlatie-veilig). Let op: deze CLI-claim moet je ook via de CLI ack-en (`s4m-queue done <id>`) — de MCP rondt CLI-claims bewust niet af.

**CLI-fallback** (jp, of als de MCP onbereikbaar is): `push · next · inbox · done · fail · peek · list · status · requeue · cancel`; `--as` verplicht bij push/next/inbox/peek; `inbox --in-reply-to <id,...>` filtert op je eigen requests. Env vereist (`S4M_QUEUE_URL` + `S4M_SERVER`): mac = `~/.zshenv`; scrum4me-server en max2 = `~/.config/s4m-queue.env` (die hosts hebben geen `~/.zshenv`) — source in hetzelfde commando. `s4m-queue --help` werkt zonder env.

**Bestemmingen:** agents `scrum4me-server:claude`, `scrum4me-server:codex`, `max2:claude`, `mac:claude`, `mac:codex`; mens `mac:jp` — JP claimt via terminal (`s4m-queue next --as jp`) of het Messages-dashboard in **scrum4me-workers** (`/queue/messages`). Stuur aan JP wat review/akkoord vereist dat je niet zelf kunt beslissen.

**`kimi` is géén bestemming.** Het model staat wél in het vocabulaire — `mac:kimi` wordt door de validatie geaccepteerd — maar Kimi claimt zijn eigen requests niet, dus een bericht daarheen wordt nooit opgehaald. Stuur werk dat voor Kimi bedoeld was naar `mac:codex`. Voeg `mac:kimi` niet aan de lijst hierboven toe zolang deze regel er staat.

**Realtime:** elke statuswisseling emit een NotifyEnvelope (`{id, type, from_*, to_*, in_reply_to, status, previous_status}`) op kanaal `agent_queue`. Wait-tools, CLI `--wait` en het dashboard gebruiken dit — niet pollen.
~~~
