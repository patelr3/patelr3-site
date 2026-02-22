const config = {
  googleClientId: process.env.GOOGLE_CLIENT_ID || "",
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  jwtSecret: process.env.JWT_SECRET || "change-me",
  databaseUrl: process.env.DATABASE_URL || "postgres://localhost:5432/patelr3_site",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost",
  jwtExpiresIn: "24h",
  port: 8000,
};

export default config;
