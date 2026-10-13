import { resolveDeployment } from "./config.js";
import { TOOL_DEFS, runTool } from "./webtools.js";

const MAX_ITERS = 5;

// Agentic chat: model may call web_fetch / web_search / web_news, results feed back in.
// Falls back to plain chatCompletion behavior when the endpoint errors on tools.
export async function chatWithTools(cfg, agentId, userPrompt, { extraContext = "" } = {}) {
  const agent = cfg.agents.get(agentId);
  if (!agent) throw new Error(`Unknown agent '${agentId}'`);
  const deployment = resolveDeployment(agent, cfg.azure.deployment);
  const rawEndpoint = (cfg.azure.endpoint || "").replace(/\/$/, "");
  const isGpt5 = /gpt-5/i.test(deployment);

  const v1Index = rawEndpoint.indexOf("/openai/v1");
  let url, headers, useV1;
  if (v1Index !== -1) {
    url = `${rawEndpoint.slice(0, v1Index + "/openai/v1".length)}/chat/completions`;
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.azure.apiKey}` };
    useV1 = true;
  } else {
    url = `${rawEndpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(cfg.azure.apiVersion)}`;
    headers = { "Content-Type": "application/json", "api-key": cfg.azure.apiKey };
    useV1 = false;
  }

  const system = extraContext ? `${agent.systemPrompt}\n\nContext from memory:\n${extraContext}` : agent.systemPrompt;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userPrompt },
  ];

  for (let iter = 0; iter < MAX_ITERS; iter += 1) {
    const body = { messages, tools: TOOL_DEFS.map((t) => ({ type: "function", function: t })) };
    if (useV1) {
      body.model = deployment;
      if (agent.maxTokens) body.max_completion_tokens = agent.maxTokens;
    } else {
      if (!isGpt5 && agent.temperature !== undefined) body.temperature = agent.temperature ?? 0.7;
      if (agent.maxTokens) body.max_tokens = agent.maxTokens;
    }

    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) {
      // Endpoint may reject tools (some Foundry routes do) -> retry once without tools
      if (iter === 0) {
        const retry = await plainCall(url, headers, useV1, deployment, agent, messages);
        if (retry) return retry;
      }
      const text = await res.text().catch(() => "");
      throw new Error(`Azure OpenAI ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    const toolCalls = msg?.tool_calls ?? [];
    if (!toolCalls.length) {
      const text = (msg?.content ?? "").trim();
      if (!text) throw new Error("Azure OpenAI returned an empty response");
      return text;
    }
    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* keep {} */ }
      let result;
      try {
        result = await runTool(name, args);
      } catch (err) {
        result = `ERROR: ${String(err.message).slice(0, 200)}`;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: String(result).slice(0, 6000) });
    }
  }
  // Out of iterations: force a final answer without tools
  return plainCall(url, headers, useV1, deployment, agent, messages) ?? "I ran out of tool steps — please narrow the question.";
}

async function plainCall(url, headers, useV1, deployment, agent, messages) {
  const slim = messages.filter((m) => m.role === "system" || m.role === "user");
  const body = { messages: slim };
  if (useV1) {
    body.model = deployment;
    if (agent.maxTokens) body.max_completion_tokens = agent.maxTokens;
  } else {
    body.temperature = agent.temperature ?? 0.7;
    if (agent.maxTokens) body.max_tokens = agent.maxTokens;
  }
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}
