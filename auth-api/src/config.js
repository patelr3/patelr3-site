const config = {
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || "",
  // Google OAuth credentials — only used by OIDC IdP (deferred migration to Firebase)
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/patelr3_site",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost",
  authApiUrl: process.env.AUTH_API_URL || "",
  financeApiUrl: process.env.FINANCE_API_URL || "",
  financeApiKey: process.env.FINANCE_API_KEY || "dev-finance-key",
  // OIDC provider config (auth-api acting as IdP for ActualBudget instances)
  oidcClientId: process.env.OIDC_CLIENT_ID || "actualbudget",
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET || process.env.JWT_SECRET || "change-me",
  // Multi-client OIDC support
  oidcClients: {
    [process.env.OIDC_CLIENT_ID || "actualbudget"]: { secret: process.env.OIDC_CLIENT_SECRET || process.env.JWT_SECRET || "change-me" },
    "foundry-agent": { secret: process.env.OIDC_FOUNDRY_CLIENT_SECRET || process.env.JWT_SECRET || "change-me" },
  },
  oidcSigningKeyJwk: process.env.OIDC_SIGNING_KEY_JWK || "",
  jwtSecret: process.env.JWT_SECRET || "change-me",  // kept for OIDC backward compat only
  // Foundry (new experience) — Responses API + Conversations API
  foundryProjectEndpoint: process.env.FOUNDRY_PROJECT_ENDPOINT || "",
  foundryAgentName: process.env.FOUNDRY_AGENT_NAME || "sunnieai",
  port: 8000,
};

export default config;
