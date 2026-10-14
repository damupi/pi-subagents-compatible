import type { RoutingDecision } from "./router.ts";

export type WorkflowTemplateId =
  | "single"
  | "reconnaissance"
  | "investigate_implement"
  | "implement_review"
  | "full_coding"
  | "independent_research";

export type WorkflowPlan = {
  id: WorkflowTemplateId;
  mode: "single" | "chain" | "parallel";
  steps: Array<{ agent: string; task: string }>;
};

export const WORKFLOW_CRITERIA: Record<WorkflowTemplateId, string> = {
  single: "One specialist can complete the task without a separate handoff",
  reconnaissance: "A Scout-only repository reconnaissance or architecture-mapping task",
  investigate_implement: "Scout must locate the relevant code before Builder implements the change",
  implement_review: "Builder should implement a defined change and Reviewer should validate it",
  full_coding: "The task needs explicit planning, implementation, and independent review",
  independent_research: "Scout and Researcher should investigate independent angles in parallel",
};

const TEMPLATE_AGENTS: Record<Exclude<WorkflowTemplateId, "single">, string[]> = {
  reconnaissance: ["scout"],
  investigate_implement: ["scout", "builder"],
  implement_review: ["builder", "reviewer"],
  full_coding: ["planner", "builder", "reviewer"],
  independent_research: ["scout", "researcher"],
};

export function resolveWorkflowPlan(
  decision: RoutingDecision,
  task: string,
  availableAgents: ReadonlySet<string>,
): { plan?: WorkflowPlan; error?: string } {
  const id = decision.workflow;
  const agentNames = id === "single" ? (decision.agent ? [decision.agent] : []) : TEMPLATE_AGENTS[id];
  if (agentNames.length === 0) return { error: "Jev did not select a specialist for the single-agent workflow" };
  const missing = agentNames.filter((agent) => !availableAgents.has(agent));
  if (missing.length > 0) return { error: `workflow '${id}' requires unavailable agent${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}` };
  if (agentNames.includes("slack-courier")) return { error: "slack-courier requires an explicit, already-approved send request" };

  const steps = buildSteps(id, task, agentNames);
  return {
    plan: {
      id,
      mode: id === "independent_research" ? "parallel" : agentNames.length > 1 ? "chain" : "single",
      steps,
    },
  };
}

function buildSteps(id: WorkflowTemplateId, task: string, agents: string[]): Array<{ agent: string; task: string }> {
  const request = task.trim();
  switch (id) {
    case "reconnaissance":
      return [{ agent: agents[0]!, task: request }];
    case "investigate_implement":
      return [
        { agent: "scout", task: `Map the relevant files, dependencies, tests, and likely change areas for this request. Do not implement.\n\nRequest:\n${request}` },
        { agent: "builder", task: `Implement and validate this request using the upstream Scout handoff.\n\nRequest:\n${request}` },
      ];
    case "implement_review":
      return [
        { agent: "builder", task: `Implement and validate this request.\n\nRequest:\n${request}` },
        { agent: "reviewer", task: `Review the implementation for correctness, regressions, and missing validation using the upstream handoff. Do not modify files.\n\nRequest:\n${request}` },
      ];
    case "full_coding":
      return [
        { agent: "planner", task: `Produce a concrete implementation plan, risks, and validation steps for this request. Do not implement.\n\nRequest:\n${request}` },
        { agent: "builder", task: `Implement and validate this request using the upstream plan.\n\nRequest:\n${request}` },
        { agent: "reviewer", task: `Review the implementation for correctness, regressions, and missing validation using the upstream handoff. Do not modify files.\n\nRequest:\n${request}` },
      ];
    case "independent_research":
      return [
        { agent: "scout", task: `Investigate the repository and local-code angle of this request. Return exact files and evidence.\n\nRequest:\n${request}` },
        { agent: "researcher", task: `Investigate an independent research and documentation angle of this request. Return sources and evidence.\n\nRequest:\n${request}` },
      ];
    case "single":
    default:
      return [{ agent: agents[0]!, task: request }];
  }
}
