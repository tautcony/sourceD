# AGENTS.md

## Execution Protocol

- **Mandatory Planning Step**
  - Before starting any task, you MUST create a clear execution plan.
  - The plan MUST be written in Markdown format.
  - The plan should include:
    - Task breakdown
    - Key assumptions (if any)
    - Execution steps
  - Do NOT proceed with implementation until the plan is completed.

- **Plan → Execute Workflow**
  1. Generate plan (Markdown)
  2. Validate internal consistency
  3. Execute step-by-step based on the plan
  4. Update plan if deviations are required

---

## Interaction Rules

- **Question Handling**
  - Any clarification or missing information MUST be handled using the `askQuestions` tool.
  - Avoid interrupting the workflow with direct conversational questions.
  - Batch questions when possible to reduce interaction overhead.

- **Continuity Principle**
  - Do not pause execution unnecessarily.
  - Make reasonable assumptions when safe, and document them in the plan.
  - Prefer forward progress over blocking.

---

## Quality Requirements

- Ensure outputs are:
  - Deterministic
  - Reproducible
  - Consistent with the plan

- If implementation diverges from the plan:
  - Explicitly update the plan before continuing

---

## Summary

- Always **plan first (Markdown)**
- Always **use `askQuestions` for user queries**
- Always **execute according to plan**
- Never **break flow unnecessarily**
