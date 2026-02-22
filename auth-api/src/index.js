import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import config from "./config.js";
import { initDb, upsertGoogleUser, findUserByEmail, createLocalUser } from "./db.js";

const app = express();
app.use(express.json());
app.use(cookieParser());

// CORS — allow frontend origin for cross-origin API calls in production
const allowedOrigins = [config.frontendUrl];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(
  session({
    secret: config.jwtSecret,
    resave: false,
    saveUninitialized: false,
  })
);
app.use(passport.initialize());
app.use(passport.session());

function issueJwtCookie(res, user) {
  const payload = {
    sub: String(user.id),
    email: user.email,
    name: user.display_name,
    role: user.role,
  };
  const token = jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
  const isProduction = !!config.authApiUrl;
  res.cookie("access_token", token, {
    httpOnly: true,
    sameSite: isProduction ? "none" : "lax",
    secure: isProduction,
    maxAge: 24 * 60 * 60 * 1000,
    path: "/",
  });
  return token;
}

// ── Passport Google OAuth ──────────────────────────────────────

passport.use(
  new GoogleStrategy(
    {
      clientID: config.googleClientId,
      clientSecret: config.googleClientSecret,
      callbackURL: config.authApiUrl
        ? `${config.authApiUrl}/auth/callback/google`
        : `${config.frontendUrl}/api/auth/callback/google`,
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        const user = await upsertGoogleUser(profile);
        done(null, user);
      } catch (err) {
        done(err);
      }
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ── Google OAuth routes ────────────────────────────────────────

app.get(
  "/auth/login/google",
  passport.authenticate("google", { scope: ["openid", "email", "profile"] })
);

app.get(
  "/auth/callback/google",
  passport.authenticate("google", { failureRedirect: config.frontendUrl }),
  (req, res) => {
    issueJwtCookie(res, req.user);
    res.redirect(config.frontendUrl);
  }
);

// ── Email/password routes ──────────────────────────────────────

app.post("/auth/register", async (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }

  const existing = await findUserByEmail(email);
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists" });
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const user = await createLocalUser(email, hash, displayName || email.split("@")[0]);
    issueJwtCookie(res, user);
    res.status(201).json({ authenticated: true, email: user.email, name: user.display_name, role: user.role });
  } catch (err) {
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = await findUserByEmail(email);
  if (!user || !user.password_hash) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  issueJwtCookie(res, user);
  res.json({ authenticated: true, email: user.email, name: user.display_name, role: user.role });
});

// ── Current user / verify / logout ─────────────────────────────

app.get("/auth/me", (req, res) => {
  const token = req.cookies.access_token;
  if (!token) return res.status(401).json({ authenticated: false });

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    res.json({
      authenticated: true,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    });
  } catch {
    res.status(401).json({ authenticated: false });
  }
});

app.get("/auth/verify", (req, res) => {
  const token = req.cookies.access_token;
  if (!token) return res.sendStatus(401);

  try {
    const payload = jwt.verify(token, config.jwtSecret);
    res.set("X-Auth-User", payload.email || "");
    res.set("X-Auth-Role", payload.role || "");
    res.sendStatus(200);
  } catch {
    res.sendStatus(401);
  }
});

app.get("/auth/logout", (_req, res) => {
  res.clearCookie("access_token", { path: "/" });
  res.redirect(config.frontendUrl);
});

// ── Start ──────────────────────────────────────────────────────

initDb()
  .then(() => {
    app.listen(config.port, "0.0.0.0", () => {
      console.log(`auth-api listening on :${config.port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
