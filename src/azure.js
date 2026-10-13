import { resolveDeployment } from "./config.js";

export async function chatCompletion(cfg, agentId, userPrompt) {
  const agent = cfg.agents.get(agentId);
  if (!agent) throw new Error(`Unknown agent '${agentId}'`);
  const deployment = resolveDeployment(agent, cfg.azure.deployment);
  const rawEndpoint = (cfg.azure.endpoint || "").replace(/\/$/, "");

  // Support both endpoint styles:
  //  A) Classic Azure OpenAI: https://<resource>.openai.azure.com
  //     -> {endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...
  //  B) Foundry v1 (what you have): https://<resource>.services.ai.azure.com/openai/v1[/responses]
  //     -> {base}/openai/v1/chat/completions with Bearer auth + {model}
  let url;
  let headers;
  let body;
  const isGpt5 = /gpt-5/i.test(deployment);
  const v1Index = rawEndpoint.indexOf("/openai/v1");
  if (v1Index !== -1) {
    const base = rawEndpoint.slice(0, v1Index + "/openai/v1".length);
    url = `${base}/chat/completions`;
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${cfg.azure.apiKey}` };
    body = {
      model: deployment,
      messages: [
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    // gpt-5 series only allows default temperature; newer API uses max_completion_tokens
    if (!isGpt5 && agent.temperature !== undefined) body.temperature = agent.temperature;
    if (agent.maxTokens) body.max_completion_tokens = agent.maxTokens;
  } else {
    url = `${rawEndpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(cfg.azure.apiVersion)}`;
    headers = { "Content-Type": "application/json", "api-key": cfg.azure.apiKey };
    body = {
      messages: [
        { role: "system", content: agent.systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (!isGpt5 && agent.temperature !== undefined) body.temperature = agent.temperature ?? 0.7;
    if (agent.maxTokens) body.max_tokens = agent.maxTokens;
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Azure OpenAI ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Azure OpenAI returned an empty response");
  return text;
}
