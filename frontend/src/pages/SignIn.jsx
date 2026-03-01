import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
} from "firebase/auth";
import { auth, googleProvider } from "../firebase";
import api from "../api";

export default function SignIn({ onSuccess }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const fetchUserProfile = async (firebaseUser) => {
    const token = await firebaseUser.getIdToken();
    const res = await fetch(api.authMe(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      const data = await res.json();
      onSuccess(data);
      navigate("/dashboard");
    } else {
      setError("Failed to load user profile");
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      let userCredential;
      if (mode === "register") {
        userCredential = await createUserWithEmailAndPassword(auth, email, password);
        if (displayName) {
          await updateProfile(userCredential.user, { displayName });
        }
      } else {
        userCredential = await signInWithEmailAndPassword(auth, email, password);
      }
      await fetchUserProfile(userCredential.user);
    } catch (err) {
      const msg = err.code === "auth/email-already-in-use"
        ? "An account with this email already exists"
        : err.code === "auth/invalid-credential"
        ? "Invalid email or password"
        : err.code === "auth/weak-password"
        ? "Password must be at least 6 characters"
        : err.message || "Something went wrong";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError("");
    setLoading(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      await fetchUserProfile(result.user);
    } catch (err) {
      if (err.code !== "auth/popup-closed-by-user") {
        setError(err.message || "Google sign-in failed");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page signin-page">
      <div className="signin-card">
        <h2>Welcome</h2>
        <p className="signin-subtitle">
          {mode === "login"
            ? "Sign in to your account"
            : "Create a new account"}
        </p>

        <form onSubmit={handleSubmit}>
          {mode === "register" && (
            <label>
              Display Name
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your name"
              />
            </label>
          )}
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "register" ? "Min 6 characters" : "Enter password"}
              required
              minLength={mode === "register" ? 6 : undefined}
            />
          </label>

          {error && <p className="signin-error">{error}</p>}

          <button type="submit" className="signin-submit" disabled={loading}>
            {loading ? "Please wait…" : mode === "login" ? "Sign In" : "Create Account"}
          </button>
        </form>

        <div className="signin-divider">
          <span>or</span>
        </div>

        <button onClick={handleGoogleSignIn} className="google-btn" disabled={loading}>
          <svg viewBox="0 0 48 48" width="20" height="20">
            <path fill="#4285F4" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#34A853" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#EA4335" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Continue with Google
        </button>

        <p className="signin-toggle">
          {mode === "login" ? (
            <>
              Don't have an account?{" "}
              <button type="button" onClick={() => { setMode("register"); setError(""); }}>
                Sign up
              </button>
              {" · "}
              <button type="button" onClick={() => navigate("/reset-password")} className="forgot-link">
                Forgot password?
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button type="button" onClick={() => { setMode("login"); setError(""); }}>
                Sign in
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
