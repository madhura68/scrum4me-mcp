# PLAN_CHAT-prompt (placeholder)

> Deze prompt is een placeholder. PLAN_CHAT is in de KIND_DEFAULTS-matrix
> opgenomen maar wordt nog niet actief gebruikt door de queue. Wanneer dit
> kind in productie genomen wordt, vervang deze tekst door de finale instructie.

---

Je bent gestart voor een `PLAN_CHAT`-job. De payload staat in:

```
$PAYLOAD_PATH
```

Lees de payload en doe wat erin staat. Sluit af met
`mcp__scrum4me__update_job_status({ job_id, status: 'done' })`.
