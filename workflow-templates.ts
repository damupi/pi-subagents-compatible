export type WorkflowMode = "single" | "chain" | "parallel";

export type WorkflowStep = {
  agent: string;
  task: string;
};

export type WorkflowTemplate = {
  description: string;
  mode: WorkflowMode;
  steps: WorkflowStep[];
};

export type WorkflowTemplates = Record<string, WorkflowTemplate>;

export type WorkflowPlan = {
  id: string;
  mode: WorkflowMode;
  steps: WorkflowStep[];
};

export const SYSTEM_WORKFLOW_CRITERIA = {
  single: "One available specialist can complete the task without a separate handoff",
  unclassified: "None of the configured workflows clearly fits; return control to the parent agent or human instead of forcing a workflow",
} as const;

const RESERVED_WORKFLOW_IDS = new Set(Object.keys(SYSTEM_WORKFLOW_CRITERIA));
const WORKFLOW_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_CUSTOM_WORKFLOWS = 46;
const MAX_WORKFLOW_DESCRIPTION_CHARS = 360;
const MAX_WORKFLOW_STEPS = 16;
const MAX_STEP_TASK_CHARS = 16_000;

export function workflowCriteria(templates: WorkflowTemplates): Record<string, string> {
  const configured = Object.entries(templates)
    .filter(([id]) => !RESERVED_WORKFLOW_IDS.has(id))
    .map(([id, template]) => [id, template.description] as const);
  return {
    single: SYSTEM_WORKFLOW_CRITERIA.single,
    ...Object.fromEntries(configured),
    unclassified: SYSTEM_WORKFLOW_CRITERIA.unclassified,
  };
}

export function mergeWorkflowTemplates(base: WorkflowTemplates, override: WorkflowTemplates): WorkflowTemplates {
  const merged: WorkflowTemplates = Object.assign(Object.create(null), base);
  for (const [id, template] of Object.entries(override)) {
    if (Object.hasOwn(merged, id) || Object.keys(merged).length < MAX_CUSTOM_WORKFLOWS) merged[id] = template;
  }
  return merged;
}

export function normalizeWorkflowTemplates(input: unknown): WorkflowTemplates {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const templates: WorkflowTemplates = Object.create(null);

  for (const [rawId, rawTemplate] of Object.entries(input)) {
    if (Object.keys(templates).length >= MAX_CUSTOM_WORKFLOWS) break;
    const id = rawId.trim();
    if (!WORKFLOW_ID_PATTERN.test(id) || RESERVED_WORKFLOW_IDS.has(id) || !rawTemplate || typeof rawTemplate !== "object" || Array.isArray(rawTemplate)) continue;
    const candidate = rawTemplate as Record<string, unknown>;
    const description = typeof candidate.description === "string" ? candidate.description.trim() : "";
    const mode = candidate.mode;
    const rawSteps = candidate.steps;
    if (!description || description.length > MAX_WORKFLOW_DESCRIPTION_CHARS || (mode !== "single" && mode !== "chain" && mode !== "parallel") || !Array.isArray(rawSteps) || rawSteps.length === 0 || rawSteps.length > MAX_WORKFLOW_STEPS) continue;

    const steps: WorkflowStep[] = [];
    let valid = true;
    for (const rawStep of rawSteps) {
      if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) {
        valid = false;
        break;
      }
      const step = rawStep as Record<string, unknown>;
      const agent = typeof step.agent === "string" ? step.agent.trim() : "";
      const task = typeof step.task === "string" ? step.task.trim() : "";
      if (!agent || !task || task.length > MAX_STEP_TASK_CHARS) {
        valid = false;
        break;
      }
      steps.push({ agent, task });
    }
    if (!valid || (mode === "single" && steps.length !== 1)) continue;
    templates[id] = { description, mode, steps };
  }

  return templates;
}

export function resolveWorkflowPlan(
  decision: { workflow: string; agent?: string },
  task: string,
  availableAgents: ReadonlySet<string>,
  templates: WorkflowTemplates = {},
): { plan?: WorkflowPlan; error?: string } {
  const id = decision.workflow;
  if (id === "unclassified") return { error: "no configured workflow matched; the parent agent or human must choose an explicit one-off workflow" };

  let mode: WorkflowMode;
  let steps: WorkflowStep[];
  if (id === "single") {
    if (!decision.agent) return { error: "Jev did not select a specialist for the single-agent workflow" };
    mode = "single";
    steps = [{ agent: decision.agent, task: task.trim() }];
  } else {
    const template = templates[id];
    if (!template) return { error: `workflow '${id}' is not configured; return control to the parent agent` };
    mode = template.mode;
    steps = template.steps.map((step) => ({
      agent: step.agent,
      task: interpolateRequest(step.task, task),
    }));
  }

  const agentNames = steps.map((step) => step.agent);
  const missing = [...new Set(agentNames.filter((agent) => !availableAgents.has(agent)))];
  if (missing.length > 0) return { error: `workflow '${id}' requires unavailable agent${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}` };
  if (agentNames.includes("slack-courier")) return { error: "slack-courier requires an explicit, already-approved send request" };

  return { plan: { id, mode, steps } };
}

function interpolateRequest(prompt: string, task: string): string {
  return prompt.replace(/\{\{request\}\}/g, task.trim());
}
