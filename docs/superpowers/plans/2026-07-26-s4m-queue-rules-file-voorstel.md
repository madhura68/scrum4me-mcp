# De nieuwe `~/.claude/rules/s4m-queue.md` (fase 3, taak 7)

> **STATUS: ACTIEF op mac sinds 2026-07-26.** De inhoud hieronder staat sinds die
> datum in `~/.claude/rules/s4m-queue.md` op deze machine (back-up van de vorige
> versie: `~/.claude/rules/s4m-queue.md.bak-voor-fase3`). Dit document blijft staan
> als bron voor de rules-sync naar de andere hosts.
>
> **Gesynct naar `scrum4me-server` en `max2` op 2026-07-26**, nadat beide hosts hun
> MCP hadden bijgewerkt. Beide bevestigden byte-identiek (sha256 + bytes + regels).
> Op `max2` bleek het een **eerste installatie**: `~/.claude/rules/` bestond daar niet.
>
> **Er is geen `s4m-rules-apply`.** Dat commando staat wel in het oorspronkelijke plan,
> maar bestaat op deze mac niet en er is geen sync-script gevonden. De distributie is
> gedaan door de bestandsinhoud plus de sha256 als queue-taak naar beide hosts te sturen;
> zij schreven en verifieerden zelf. Werkt goed, maar het is handwerk per keer — een
> echte sync-flow ontbreekt nog.

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
- Vastzittende claims herstellen automatisch: MCP-claims ~5 min na procesdood, CLI-claims na 4 h (`S4M_RECLAIM_DEFAULT`). Levend proces maar gestrande sessie → handmatig `s4m-queue requeue <id>` (jp).

**Echt "seintje" nodig terwijl je doorwerkt?** Start de CLI als background-Bash-taak:

    source ~/.zshenv && s4m-queue inbox --as <model> --wait --in-reply-to <id,...> --json

Die blokkeert tot er een reply op jóuw requests binnenkomt (correlatie-veilig). Let op: deze CLI-claim moet je ook via de CLI ack-en (`s4m-queue done <id>`) — de MCP rondt CLI-claims bewust niet af.

**CLI-fallback** (jp, of als de MCP onbereikbaar is): `push · next · inbox · done · fail · peek · list · status · requeue · cancel`; `--as` verplicht bij push/next/inbox/peek; `inbox --in-reply-to <id,...>` filtert op je eigen requests. Env vereist (`S4M_QUEUE_URL` + `S4M_SERVER`): mac = `~/.zshenv`, scrum4me-server = `~/.config/s4m-queue.env` — source in hetzelfde commando. `s4m-queue --help` werkt zonder env.

**Bestemmingen:** agents `scrum4me-server:claude`, `scrum4me-server:codex`, `max2:claude`, `mac:claude`, `mac:codex`; mens `mac:jp` — JP claimt via terminal (`s4m-queue next --as jp`) of het Messages-dashboard in **scrum4me-workers** (`/queue/messages`). Stuur aan JP wat review/akkoord vereist dat je niet zelf kunt beslissen.

**Realtime:** elke statuswisseling emit een NotifyEnvelope (`{id, type, from_*, to_*, in_reply_to, status, previous_status}`) op kanaal `agent_queue`. Wait-tools, CLI `--wait` en het dashboard gebruiken dit — niet pollen.
~~~
