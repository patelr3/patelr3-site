const config = {
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  jwtSecret: process.env.JWT_SECRET || "change-me",
  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/patelr3_site",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost",
  authApiUrl: process.env.AUTH_API_URL || "",  // set in ACA; empty = use frontendUrl
  financeApiUrl: process.env.FINANCE_API_URL || "",  // finance-api base URL
  financeApiKey: process.env.FINANCE_API_KEY || "dev-finance-key",
  jwtExpiresIn: "24h",
  port: 8000,
};

export default config;
