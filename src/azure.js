import { resolveProvider, buildChatRequest } from "./providers.js";

export async function chatCompletion(cfg, agentId, userPrompt) {
  const agent = cfg.agents.get(agentId);
  if (!agent) throw new Error(`Unknown agent '${agentId}'`);
  const resolved = resolveProvider(cfg, agent);
  const messages = [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const { url, headers, body } = buildChatRequest(resolved, agent, messages, { withTools: false });

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${resolved.type} ${res.status}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`${resolved.type} returned an empty response`);
  return text;
}
