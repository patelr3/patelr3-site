export default function AboutMe() {
  return (
    <div className="page about">
      <h1>About Me</h1>
      <p>
        Hi, I'm Ravi Patel — a software engineer at{" "}
        <strong>Microsoft</strong> working on SQL Server. I enjoy building
        things with containers, cloud services, and modern web technologies.
      </p>
      <p style={{ marginTop: "0.5rem" }}>
        <a
          href="https://www.linkedin.com/in/patelr3/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Connect with me on LinkedIn ↗
        </a>
      </p>

      <section className="about-section">
        <h2>Hobbies &amp; Interests</h2>

        <h3>🎮 Gaming</h3>
        <p>
          I'm an avid gamer. My current top games are{" "}
          <strong>Arc: Raiders</strong>, <strong>Deadlock</strong>,{" "}
          <strong>Rocket League</strong>, and <strong>Rematch</strong>.
        </p>

        <h3>🏅 Sports</h3>
        <p>
          I love trying new sports and staying active. I typically play{" "}
          <strong>soccer</strong> (goalie) and <strong>run</strong>.
        </p>
        <p>
          <strong>Current status:</strong>{" "}
          <span className="status-badge status-injured">🩹 Injured — Dislocated Shoulder</span>
        </p>
        <p style={{ marginTop: "0.5rem" }}>
          <strong>Past accomplishments:</strong>
        </p>
        <ul className="about-list">
          <li>🏃 Ragnar Sprint Race 2025 — Seattle</li>
          <li>🚴 STP (Seattle to Portland) 2023</li>
        </ul>
      </section>

      <section className="about-section">
        <h2>Work Experience</h2>
        <ul className="about-list">
          <li>
            <strong>Microsoft</strong> — Software Engineer, SQL Server. Building
            and shipping features for one of the world's most widely used
            database engines.
          </li>
        </ul>
      </section>

      <section className="about-section">
        <h2>Education</h2>
        <ul className="about-list">
          <li>
            <strong>University of Washington</strong> — B.S., Graduated Cum
            Laude (2019). Dean's List recipient.
          </li>
          <li>
            <strong>Centralia College</strong> — A.S., Outstanding Student of
            the Year (2016). President of Phi Theta Kappa honor society (Iota
            Omega chapter).
          </li>
        </ul>
      </section>
    </div>
  );
}
