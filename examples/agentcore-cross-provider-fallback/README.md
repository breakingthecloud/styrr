# AgentCore Cross-Provider Fallback Example

Styrr as the routing layer inside a Bedrock AgentCore deployment.

```bash
OPENROUTER_API_KEY=sk-... node src/index.mjs "your prompt"
```

Ordered chain: **Bedrock** (Claude 3 Sonnet, IAM auth) → **OpenRouter** (o1) → **free**
(Llama 3.3 70B). Prints an AgentCore-handler-style response with `model`, `costTier`,
`fallbacksTried`, and `tokens`.

See `../../docs/bedrock-agentcore.md` for the full pattern.
