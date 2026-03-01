const config = {
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  jwtSecret: process.env.JWT_SECRET || "change-me",
  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/patelr3_site",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost",
  authApiUrl: process.env.AUTH_API_URL || "",  // set in ACA; empty = use frontendUrl
  financeApiUrl: process.env.FINANCE_API_URL || "",  // finance-api base URL
  financeApiKey: process.env.FINANCE_API_KEY || "dev-finance-key",
  // OIDC provider config (auth-api acting as IdP for ActualBudget instances)
  oidcClientId: process.env.OIDC_CLIENT_ID || "actualbudget",
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET || process.env.JWT_SECRET || "change-me",
  // Multi-client OIDC support (clients map keyed by client_id)
  oidcClients: {
    [process.env.OIDC_CLIENT_ID || "actualbudget"]: { secret: process.env.OIDC_CLIENT_SECRET || process.env.JWT_SECRET || "change-me" },
    "foundry-agent": { secret: process.env.OIDC_FOUNDRY_CLIENT_SECRET || process.env.JWT_SECRET || "change-me" },
  },
  // Azure AI Foundry (SunnieAI chat)
  foundryProjectEndpoint: process.env.FOUNDRY_PROJECT_ENDPOINT || "",
  foundryAgentName: process.env.FOUNDRY_AGENT_NAME || "sunnieai",
  foundryAgentId: process.env.FOUNDRY_AGENT_ID || "",  // deprecated, kept for fallback
  mcpServerUrl: process.env.MCP_SERVER_URL || "",  // external MCP server URL for per-request tool auth
  foundryMcpConnectionId: process.env.FOUNDRY_MCP_CONNECTION_ID || "",  // Foundry project connection ID for OAuth MCP passthrough
  chatEncryptionKey: process.env.CHAT_ENCRYPTION_KEY || "",  // hex-encoded 256-bit master key for chat encryption
  oidcSigningKeyJwk: process.env.OIDC_SIGNING_KEY_JWK || "",  // persistent RSA private key (JWK JSON) from AKV
  jwtExpiresIn: "24h",
  port: 8000,
};

export default config;
