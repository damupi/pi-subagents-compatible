import { WORKFLOW_CRITERIA, type WorkflowTemplateId } from "./workflow-templates.ts";

export type AgentCandidate = {
  name: string;
  description: string;
  model?: string;
  thinking?: string;
};

export type RouteMode = "main" | "single" | "chain" | "parallel" | "human";
export type AgentProfile = "deterministic_script" | "fast_agent" | "reasoning_agent" | "browser_agent" | "human";
export type RouteEffort = "low" | "medium" | "high" | "xhigh";
export type RouteRisk = "low" | "medium" | "high";

export type RoutingDecision = {
  mode: RouteMode;
  profile: AgentProfile;
  workflow: WorkflowTemplateId;
  workflowConfidence: number;
  agent?: string;
  effort: RouteEffort;
  effortScore: number;
  risk: RouteRisk;
  riskScore: number;
  needsDesktopAccess: boolean;
  confidence: number;
  reason: string;
  source: "jev" | "fallback";
  classifierAvailable: boolean;
  classifier?: string;
  model?: string;
  thinking?: string;
  alternatives: Array<{ agent: string; probability: number }>;
  warnings: string[];
  usage?: any;
};

type ChoiceAnswer = {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
};

type ScoreAnswer = {
  type?: string;
  score?: number;
  confidence?: number;
};

type BoolAnswer = {
  type?: string;
  probability?: number;
};

const MAX_TASK_CHARS = 16_000;
const MAX_AGENT_DESCRIPTION_CHARS = 360;
const MAX_AGENT_CHOICES = 48;

/**
 * Recommend a subagent route without executing it.
 * Jev receives only the current task and the concise enabled-agent roster.
 */
export async function routeSubagentTask(input: {
  task: string;
  agents: AgentCandidate[];
  ctx: any;
  signal?: AbortSignal;
}): Promise<RoutingDecision> {
  const task = input.task.trim();
  if (!task) throw new Error("Routing requires a non-empty task.");
  if (task.length > MAX_TASK_CHARS) return oversizedTaskDecision(task, input.agents);
  if (input.agents.length === 0) return fallbackDecision(task, [], "No enabled subagents are available.");

  const candidates = shortlistAgents(task, input.agents);
  const registry = input.ctx?.modelRegistry;
  const jev = await findAvailableJev(registry);
  if (!jev || typeof registry?.classify !== "function") {
    return fallbackDecision(task, candidates, "No authenticated Jev classifier is available; used deterministic fallback routing.");
  }

  try {
    // This follows the Level 5 Jev agent-router pattern: profile + scored effort/risk
    // + a boolean desktop requirement. Agent selection is constrained to the live roster.
    const result = await registry.classify(
      jev,
      {
        state: {
          task: task.slice(0, MAX_TASK_CHARS),
          agents: candidates.map((agent) => ({
            name: agent.name,
            description: agent.description.slice(0, MAX_AGENT_DESCRIPTION_CHARS),
          })),
        },
        questions: {
          profile: {
            type: "choice",
            instructions: "Which execution profile should handle this task? Choose the cheapest safe profile that can complete it reliably.",
            criteria: {
              deterministic_script: "An existing command, script, or deterministic tool can complete it without an agent",
              fast_agent: "A quick specialist on a cost-controlled model can handle a localized or routine task",
              reasoning_agent: "A strong reasoning specialist is needed for architecture, ambiguity, synthesis, or difficult debugging",
              browser_agent: "The work depends on browser interaction, logged-in web applications, or visual UI inspection",
              human: "The request is too ambiguous, sensitive, or consequential to execute without human judgment",
            },
          },
          workflow: {
            type: "choice",
            instructions: "Choose the smallest approved workflow that can complete the task reliably. Do not invent another workflow.",
            criteria: WORKFLOW_CRITERIA,
          },
          effort: {
            type: "score",
            instructions: "How much reasoning effort is required to complete the task reliably?",
            criteria: [
              "Immediate lookup, formatting, or one mechanical action",
              "Routine implementation or analysis using established patterns",
              "Multi-step investigation, debugging, synthesis, or cross-file design",
              "High-stakes cross-system reasoning with difficult trade-offs",
            ],
          },
          risk: {
            type: "score",
            instructions: "How risky would execution be, especially regarding irreversible or external side effects?",
            criteria: [
              "Read-only, advisory, or easily reversible local work",
              "Local edits or operations requiring validation",
              "Publishing, sending, deleting, deploying, credential use, or another consequential external action",
            ],
          },
          needs_desktop: {
            type: "bool",
            instructions: "Does this task require a browser, visual desktop interaction, or access to a logged-in application?",
            criteria: {
              true: "Browser, desktop, visual inspection, or authenticated web application access is required",
              false: "The task can be completed through code, files, APIs, or command-line tools",
            },
          },
          agent: {
            type: "choice",
            instructions: "Choose the one available specialist that best matches the task. The choice is advisory when the execution profile is deterministic or human.",
            criteria: Object.fromEntries(candidates.map((agent) => [
              agent.name,
              agent.description.slice(0, MAX_AGENT_DESCRIPTION_CHARS) || `Specialist agent named ${agent.name}`,
            ])),
          },
        },
      },
      { signal: input.signal },
    );

    if (result?.stopReason !== "stop") {
      const detail = typeof result?.errorMessage === "string" && result.errorMessage.trim() ? `: ${result.errorMessage.trim()}` : "";
      return fallbackDecision(task, candidates, `Jev classification ended with ${result?.stopReason || "an unknown stop reason"}${detail}; used deterministic fallback routing.`);
    }

    const profileAnswer = result.answers?.profile as ChoiceAnswer | undefined;
    const rawProfile = choice(profileAnswer, ["deterministic_script", "fast_agent", "reasoning_agent", "browser_agent", "human"] as const, "human");
    const profileConfidence = typeof profileAnswer?.confidence === "number"
      ? profileAnswer.confidence
      : probabilityFor(profileAnswer, rawProfile);
    const profile: AgentProfile = profileConfidence < 0.5 ? "human" : rawProfile;
    const workflowAnswer = result.answers?.workflow as ChoiceAnswer | undefined;
    const workflow = choice(workflowAnswer, ["single", "reconnaissance", "investigate_implement", "implement_review", "full_coding", "independent_research", "unclassified"] as const, "unclassified");
    const workflowConfidence = typeof workflowAnswer?.confidence === "number"
      ? workflowAnswer.confidence
      : probabilityFor(workflowAnswer, workflow);
    const effortScore = scoreValue(result.answers?.effort as ScoreAnswer | undefined, 1);
    const riskScore = scoreValue(result.answers?.risk as ScoreAnswer | undefined, 1);
    const effort = effortFromScore(effortScore);
    const risk = riskFromScore(riskScore);
    const needsDesktopAccess = boolProbability(result.answers?.needs_desktop as BoolAnswer | undefined) > 0.5;
    const rankedAgents = rankProbabilities(result.answers?.agent as ChoiceAnswer | undefined, new Set(candidates.map((agent) => agent.name)));
    const selected = candidates.find((agent) => agent.name === rankedAgents[0]?.agent);
    const agentConfidence = selected ? rankedAgents[0]?.probability ?? 0 : 0;
    const workflowMode: RouteMode = workflow === "unclassified"
      ? "main"
      : workflow === "independent_research"
        ? "parallel"
        : workflow === "investigate_implement" || workflow === "implement_review" || workflow === "full_coding"
          ? "chain"
          : "single";
    const confidence = Math.min(
      profileConfidence,
      workflowConfidence || profileConfidence,
      workflow === "single" ? agentConfidence || profileConfidence : profileConfidence,
    );
    const mode: RouteMode = profile === "human" || risk === "high"
      ? "human"
      : profile === "deterministic_script"
        ? "main"
        : workflowMode;
    const warnings: string[] = [];
    if (!selected && mode === "single" && workflow === "single") warnings.push("Jev did not return a valid agent; no specialist was selected.");
    if (profileConfidence < 0.5) warnings.push("Execution-profile confidence is below 0.50; routed to human review.");
    if (workflow === "unclassified") warnings.push("No reviewed workflow matched; return control to the parent agent or human for an explicit one-off workflow.");
    if (workflowConfidence < 0.6) warnings.push("Workflow confidence is below 0.60; keep this recommendation advisory.");
    if (agentConfidence < 0.6 && mode === "single" && workflow === "single") warnings.push("Agent confidence is below 0.60; keep this recommendation advisory.");
    if (risk === "high") warnings.push("High-risk work requires explicit human approval before execution.");
    if (needsDesktopAccess && profile !== "browser_agent") warnings.push("Desktop access is likely required; verify the selected agent has browser capability.");

    return {
      mode,
      profile,
      workflow,
      workflowConfidence,
      agent: selected?.name,
      effort,
      effortScore,
      risk,
      riskScore,
      needsDesktopAccess,
      confidence,
      reason: buildReason(mode, profile, workflow, selected?.name, effort, risk),
      source: "jev",
      classifierAvailable: true,
      classifier: modelReference(jev),
      model: selected?.model,
      thinking: selected?.thinking,
      alternatives: rankedAgents.slice(1, 4),
      warnings,
      usage: result.usage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fallbackDecision(task, candidates, `Jev classification failed (${message}); used deterministic fallback routing.`);
  }
}

async function findAvailableJev(registry: any): Promise<any | undefined> {
  if (!registry) return undefined;
  const preferred: Array<[string, string]> = [
    ["typesafe", "jev-latest"],
    ["openrouter", "~typesafe/jev-latest"],
    ["openrouter", "typesafe/jev-1.13"],
  ];
  try {
    if (typeof registry.getAvailableOfType === "function") {
      const available = await registry.getAvailableOfType("classifier");
      for (const [provider, id] of preferred) {
        const match = available.find((model: any) => model?.provider === provider && model?.id === id);
        if (match) return match;
      }
      return undefined;
    }
    if (typeof registry.findOfType === "function") {
      const direct = registry.findOfType("classifier", "typesafe", "jev-latest");
      if (direct && (typeof registry.hasConfiguredAuth !== "function" || registry.hasConfiguredAuth(direct))) return direct;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function modelReference(model: any): string | undefined {
  return typeof model?.provider === "string" && typeof model?.id === "string" ? `${model.provider}/${model.id}` : undefined;
}

function oversizedTaskDecision(task: string, agents: AgentCandidate[]): RoutingDecision {
  const decision = fallbackDecision(task, shortlistAgents(task, agents), `Task exceeds the ${MAX_TASK_CHARS.toLocaleString()}-character classifier limit; human review is required instead of classifying a partial request.`);
  return {
    ...decision,
    mode: "human",
    profile: "human",
    risk: "high",
    riskScore: 2,
    reason: buildReason("human", "human", decision.workflow, undefined, decision.effort, "high"),
    agent: undefined,
    model: undefined,
    thinking: undefined,
  };
}

function shortlistAgents(task: string, agents: AgentCandidate[]): AgentCandidate[] {
  if (agents.length <= MAX_AGENT_CHOICES) return agents;
  return agents
    .map((agent) => ({ agent, score: lexicalAgentScore(task, agent) }))
    .sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name))
    .slice(0, MAX_AGENT_CHOICES)
    .map((item) => item.agent);
}

function fallbackDecision(task: string, agents: AgentCandidate[], warning: string): RoutingDecision {
  const ranked = agents
    .map((agent) => ({ agent, score: lexicalAgentScore(task, agent) }))
    .sort((a, b) => b.score - a.score || a.agent.name.localeCompare(b.agent.name));
  const best = ranked[0];
  const second = ranked[1];
  const selected = best && best.score > 0 ? best.agent : undefined;
  const confidence = selected ? Math.min(0.59, best.score / Math.max(4, best.score + (second?.score ?? 0))) : 0;
  const risk = heuristicRisk(task);
  const effort = heuristicEffort(task);
  const needsDesktopAccess = /\b(browser|website|web app|desktop|ui|visual|login|logged[- ]in)\b/i.test(task);
  const profile: AgentProfile = risk === "high"
    ? "human"
    : needsDesktopAccess
      ? "browser_agent"
      : effort === "high" || effort === "xhigh"
        ? "reasoning_agent"
        : selected
          ? "fast_agent"
          : "deterministic_script";
  const mode: RouteMode = risk === "high" ? "human" : selected ? "single" : "main";
  return {
    mode,
    profile,
    workflow: "single",
    workflowConfidence: confidence,
    agent: selected?.name,
    effort,
    effortScore: effort === "low" ? 0 : effort === "medium" ? 1 : effort === "high" ? 2 : 3,
    risk,
    riskScore: risk === "low" ? 0 : risk === "medium" ? 1 : 2,
    needsDesktopAccess,
    confidence,
    reason: buildReason(mode, profile, "single", selected?.name, effort, risk),
    source: "fallback",
    classifierAvailable: false,
    model: selected?.model,
    thinking: selected?.thinking,
    alternatives: ranked
      .filter((item) => item.agent.name !== selected?.name && item.score > 0)
      .slice(0, 3)
      .map((item) => ({ agent: item.agent.name, probability: 0 })),
    warnings: [warning, ...(risk === "high" ? ["High-risk work requires explicit human approval before execution."] : [])],
  };
}

function lexicalAgentScore(task: string, agent: AgentCandidate): number {
  const taskTokens = tokenSet(task);
  const nameTokens = tokenSet(agent.name.replace(/[._-]+/g, " "));
  const descriptionTokens = tokenSet(agent.description);
  let score = 0;
  for (const token of taskTokens) {
    if (nameTokens.has(token)) score += 5;
    if (descriptionTokens.has(token)) score += 1;
  }
  const normalizedTask = task.toLowerCase();
  const normalizedName = agent.name.toLowerCase().replace(/[._-]+/g, " ");
  if (normalizedName.length >= 4 && normalizedTask.includes(normalizedName)) score += 10;
  return score;
}

function tokenSet(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length >= 3) ?? []);
}

function heuristicRisk(task: string): RouteRisk {
  return /\b(send|publish|deploy|delete|remove|drop|reset|merge|push|release|production|credential|payment|purchase|approve)\b/i.test(task)
    ? "high"
    : /\b(edit|write|implement|fix|change|update|create|install|migrate)\b/i.test(task)
      ? "medium"
      : "low";
}

function heuristicEffort(task: string): RouteEffort {
  if (/\b(architecture|cross[- ]system|security|incident|root cause|migration|high[- ]stakes)\b/i.test(task)) return "xhigh";
  if (/\b(debug|investigate|analyse|analyze|design|review|refactor|implement|compare|synthesi[sz]e)\b/i.test(task) || task.length > 700) return "high";
  if (/\b(find|list|format|rename|lookup|check|show)\b/i.test(task) && task.length < 240) return "low";
  return "medium";
}

function choice<const T extends readonly string[]>(answer: ChoiceAnswer | undefined, allowed: T, fallback: T[number]): T[number] {
  if (answer?.type === "choice" && answer.choice && allowed.includes(answer.choice)) return answer.choice as T[number];
  const ranked = rankProbabilities(answer, new Set(allowed));
  return (ranked[0]?.agent as T[number] | undefined) ?? fallback;
}

function probabilityFor(answer: ChoiceAnswer | undefined, key: string): number {
  const value = answer?.probabilities?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function scoreValue(answer: ScoreAnswer | undefined, fallback: number): number {
  return answer?.type === "score" && typeof answer.score === "number" && Number.isFinite(answer.score) ? answer.score : fallback;
}

function boolProbability(answer: BoolAnswer | undefined): number {
  return answer?.type === "bool" && typeof answer.probability === "number" && Number.isFinite(answer.probability) ? answer.probability : 0;
}

function effortFromScore(score: number): RouteEffort {
  if (score < 0.5) return "low";
  if (score < 1.5) return "medium";
  if (score < 2.5) return "high";
  return "xhigh";
}

function riskFromScore(score: number): RouteRisk {
  if (score < 0.5) return "low";
  if (score < 1.5) return "medium";
  return "high";
}

function rankProbabilities(answer: ChoiceAnswer | undefined, allowed: Set<string>): Array<{ agent: string; probability: number }> {
  if (answer?.type !== "choice" || !answer.probabilities) return [];
  return Object.entries(answer.probabilities)
    .filter(([name, probability]) => allowed.has(name) && Number.isFinite(probability))
    .map(([agent, probability]) => ({ agent, probability }))
    .sort((a, b) => b.probability - a.probability || a.agent.localeCompare(b.agent));
}

function buildReason(mode: RouteMode, profile: AgentProfile, workflow: WorkflowTemplateId, agent: string | undefined, effort: RouteEffort, risk: RouteRisk): string {
  const target = agent ? `lead specialist '${agent}'` : "no specialist";
  return `Recommended ${mode} handling through ${profile} using workflow '${workflow}' with ${target}; estimated effort ${effort} and risk ${risk}.`;
}
