---
title: Worker context overview
status: active
date: 2026-05-24
product: scrum4me-mcp
---

# Worker Context Overview

Dit document beschrijft welke context elke Scrum4Me worker/job-kind met de huidige configuratie krijgt. De context komt uit `wait_for_job`: de docker-runner geeft de worker een kind-prompt en een JSON-payload op `$PAYLOAD_PATH`.

## Huidige DB-context voor SC2

Voor product `SC2 / scrum4me-mcp` geeft `get_claude_context` momenteel:

- Active sprint: geen.
- Next story: geen.
- Open ideas: onder andere `IDEA-018`, `IDEA-042`, `IDEA-050`, `IDEA-054`, `IDEA-055`, `IDEA-056`, `IDEA-077`.

## Config Cascade

Bij claimen wordt `config` bepaald via deze volgorde:

1. `task.requires_opus === true` forceert Opus.
2. `ClaudeJob.requested_model`, `requested_thinking_budget`, `requested_permission_mode`.
3. `Product.preferred_model`, `thinking_budget_default`, `preferred_permission_mode`.
4. Hardcoded defaults in `src/lib/job-config.ts`.

## IDEA_GRILL

Doel: idee concretiseren tot grill-document.

Payload bevat:

- `job_id`, `kind`, `status`
- `config`
- `idea`: `id`, `code`, `title`, `description`, `grill_md`, `plan_md`, `status`, `product_id`
- `product`: `id`, `name`, `repo_url`, `definition_of_done`
- `pbi` als het idee al gekoppeld is
- `repo_url`
- `prompt_text`
- `branch_suggestion`
- `product_worktrees`
- `primary_worktree_path`

Default config:

- model: `claude-sonnet-4-6`
- thinking budget: `12000`
- permission mode: `acceptEdits`
- max turns: `15`

Belangrijkste tools:

- `Read`, `Grep`, `Glob`, `WebSearch`, `AskUserQuestion`
- ProductDoc read/search tools
- `update_idea_grill_md`
- `log_idea_decision`
- `update_job_status`
- vraag/antwoord tools

## IDEA_MAKE_PLAN

Doel: van grill-resultaat naar implementeerbaar plan.

Payload is dezelfde idea-job basis als `IDEA_GRILL`, met vooral:

- `idea.grill_md` als primaire input
- `idea.plan_md` als eventuele vorige versie
- product- en repo-context
- `primary_worktree_path`

Default config:

- model: `claude-opus-4-7`
- thinking budget: `24000`
- permission mode: `acceptEdits`
- max turns: `20`

Belangrijkste tools:

- `Read`, `Grep`, `Glob`, `WebSearch`, `AskUserQuestion`, `Write`
- ProductDoc read/search tools
- `update_idea_plan_md`
- `log_idea_decision`
- `update_job_status`

Promptregel: deze job stelt geen vragen; ontbrekende informatie wordt als aanname in het plan vastgelegd.

## IDEA_REVIEW_PLAN

Doel: bestaand idea-plan actief reviewen en verbeteren.

Payload is dezelfde idea-job basis als `IDEA_GRILL`, met vooral:

- `idea.plan_md`: te reviewen plan-document
- `idea.grill_md`: scope/acceptatie-context
- `product`: definition of done en repo-context
- `repo_url`
- worktree-info indien beschikbaar

Default config:

- model: `claude-opus-4-7`
- thinking budget: `6000`
- permission mode: `acceptEdits`
- max turns: `1`

Belangrijkste tools:

- `Read`, `Write`, `Grep`, `Glob`
- ProductDoc read/search tools
- `update_idea_plan_md`
- `update_idea_plan_reviewed`
- `log_idea_decision`
- `update_job_status`
- `ask_user_question`

## PLAN_CHAT

Status: aanwezig in schema/config, maar prompt is placeholder.

Default config:

- model: `claude-sonnet-4-6`
- thinking budget: `6000`
- permission mode: `acceptEdits`
- max turns: `5`

Belangrijkste tools:

- `Read`, `Grep`, `AskUserQuestion`
- ProductDoc read/search tools
- `update_job_status`

Let op: `wait_for_job` maakt `PLAN_CHAT` claimbaar, maar `getFullJobContext()` bouwt nog geen aparte payload voor `PLAN_CHAT`. Een standalone `PLAN_CHAT` job kan daardoor falen met incomplete context.

## TASK_IMPLEMENTATION

Doel: één taak implementeren in een geïsoleerde worktree.

Payload bevat:

- `job_id`, `kind`, `status`
- `config`
- `task`: `id`, `title`, `description`, `implementation_plan`, `priority`, `repo_url`
- `story`: `id`, `title`, `description`, `acceptance_criteria`
- `pbi`: `id`, `title`, `priority`, `status`
- `sprint`: `id`, `goal`, `status` of `null`
- `product`: `id`, `name`, `repo_url`
- `branch_suggestion`
- extra door `wait_for_job`: `worktree_path`, `branch_name`

Default config:

- model: `claude-sonnet-4-6`
- thinking budget: `6000`
- permission mode: `bypassPermissions`
- max turns: `50`

Belangrijkste tools:

- `Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`
- `get_claude_context`
- `get_agent_guide`
- ProductDoc read/search tools
- task status, plan, log, test, commit en verify tools
- `update_job_status`
- vraag/antwoord tools
- `worker_heartbeat`

Agent-guide:

- zit niet direct in de payload
- prompt verplicht eerst `get_agent_guide({ product_id })`
- `guide_md` is bindend voor bouw- en documenteerdiscipline

## SPRINT_IMPLEMENTATION

Doel: een hele sprint-run sequentieel afhandelen vanuit een frozen snapshot.

Payload bevat:

- `job_id`, `kind`, `status`
- `config`
- `sprint`: `id`, `sprint_goal`, `status`
- `sprint_run`: `id`, `pr_strategy`, `branch`, `previous_run_id`
- `product`: `id`, `name`, `repo_url`, `definition_of_done`, `auto_pr`
- `pbis[]`
- `stories[]`
- `task_executions[]`
- `worktree_path`
- `branch_name`
- `repo_url`
- `base_sha`
- `heartbeat_interval_seconds: 60`

Elke `task_executions[]` entry bevat:

- `execution_id`
- `task_id`
- `code`
- `title`
- `story_id`
- `order`
- `plan_snapshot`
- `verify_required`
- `verify_only`
- `base_sha` alleen voor de eerste taak

Default config:

- model: `claude-sonnet-4-6`
- thinking budget: `6000`
- permission mode: `bypassPermissions`
- max turns: onbeperkt

Belangrijkste tools:

- alle task implementation tools
- `Agent`
- `update_task_execution`
- `verify_sprint_task`

Agent-guide:

- prompt verplicht `get_agent_guide({ product_id })`
- huidige prompt geeft `guide_md` door aan sub-agents zodat de daadwerkelijke executor de guide ook volgt

## Bronnen in code

- `prisma/schema.prisma`: `ClaudeJobKind`, `ClaudeJob`, `SprintTaskExecution`
- `src/lib/job-config.ts`: model/mode/tool defaults
- `src/tools/wait-for-job.ts`: payload-opbouw per job-kind
- `src/prompts/idea/*.md`: idea worker prompts
- `src/prompts/task/implementation.md`: task worker prompt
- `src/prompts/sprint/implementation.md`: sprint worker prompt
- `src/lib/agent-guide.ts`: agent-guide resolver
- `src/tools/get-agent-guide.ts`: `get_agent_guide` MCP tool
