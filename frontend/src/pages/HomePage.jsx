import { useNavigate } from "react-router-dom";

const SERVICE_PREVIEWS = [
  {
    name: "Actual Budget",
    description:
      "A self-hosted personal finance manager. Each user gets their own isolated cloud instance.",
    icon: "💰",
  },
  {
    name: "BuddyBurn",
    description:
      "An app that helps buddies burn calories. Workout with your workout partner anywhere, anytime together!",
    icon: "🔥",
  },
];

export default function HomePage({ user }) {
  const navigate = useNavigate();

  return (
    <div className="page home">
      <section className="hero">
        <h1>Welcome to the Arayosun site</h1>
        <p>
          This is a personal platform where I build and host cloud-native
          services. Sign in to explore interactive microservices, request access
          to restricted tools, and spin up your own cloud instances.
        </p>
        {!user && (
          <button className="hero-cta" onClick={() => navigate("/signin")}>
            Sign In to Get Started
          </button>
        )}
        {user && (
          <button className="hero-cta" onClick={() => navigate("/dashboard")}>
            Go to Dashboard
          </button>
        )}
      </section>

      <section className="services-preview">
        <h2>Available Services</h2>
        <div className="preview-grid">
          {SERVICE_PREVIEWS.map((svc) => (
            <div key={svc.name} className="preview-card">
              <span className="preview-icon">{svc.icon}</span>
              <h3>{svc.name}</h3>
              <p>{svc.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="how-it-works">
        <h2>How It Works</h2>
        <ol className="steps-list">
          <li>
            <strong>Sign in</strong> with your Google account or create a
            username &amp; password.
          </li>
          <li>
            <strong>Browse services</strong> on the Dashboard — open any service
            that is available to you.
          </li>
          <li>
            <strong>Request access</strong> to restricted services and wait for
            admin approval.
          </li>
          <li>
            <strong>Launch instances</strong> — some services provision a
            dedicated cloud environment just for you.
          </li>
        </ol>
      </section>
    </div>
  );
}
