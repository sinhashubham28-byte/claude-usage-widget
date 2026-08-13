// Übersicht widget — Claude Pro/Max usage tracker
// Install Übersicht from http://tracesof.net/uebersicht/ (free), then place
// this file in a folder inside ~/Library/Application Support/Übersicht/widgets/
// e.g. ~/Library/Application Support/Übersicht/widgets/claude-usage/index.jsx

export const command =
  "cat ~/.cache/claude-usage/latest.json 2>/dev/null; echo '---SPLIT---'; cat ~/.cache/claude-usage/last_updated.txt 2>/dev/null";

export const refreshFrequency = 15000; // check every 15s (cheap, just reads local files)

export const className = `
  top: 20px;
  right: 20px;
  width: 250px;
  font-family: -apple-system, "SF Pro Display", "Helvetica Neue", sans-serif;
  color: #fff;
  z-index: 1;
`;

const colorFor = (pct) => (pct >= 80 ? "#ff5f56" : pct >= 50 ? "#ffbd2e" : "#27c93f");

const Bar = ({ pct }) => (
  <div
    style={{
      background: "rgba(255,255,255,0.15)",
      borderRadius: 6,
      height: 8,
      overflow: "hidden",
      marginTop: 4,
    }}
  >
    <div
      style={{
        width: `${Math.min(pct, 100)}%`,
        background: colorFor(pct),
        height: "100%",
        transition: "width 0.4s ease",
      }}
    />
  </div>
);

const timeUntil = (unixSeconds) => {
  if (!unixSeconds) return "";
  const diffMs = unixSeconds * 1000 - Date.now();
  if (diffMs <= 0) return "resetting…";
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  return `resets in ${h}h ${m}m`;
};

const Row = ({ label, window_ }) => {
  if (!window_) {
    return (
      <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 10 }}>
        {label}: no data yet — send a message in Claude Code
      </div>
    );
  }
  const pct = Math.round(window_.used_percentage);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
        <span>{label}</span>
        <span>{pct}%</span>
      </div>
      <Bar pct={pct} />
      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{timeUntil(window_.resets_at)}</div>
    </div>
  );
};

export const render = ({ output }) => {
  const wrapperStyle = {
    background: "rgba(20,20,24,0.85)",
    borderRadius: 16,
    padding: "16px 18px",
    boxShadow: "0 4px 20px rgba(0,0,0,0.35)",
    backdropFilter: "blur(10px)",
  };

  if (!output) {
    return (
      <div style={wrapperStyle}>
        <div style={{ fontSize: 13, opacity: 0.7 }}>Claude Usage</div>
        <div style={{ fontSize: 12, opacity: 0.55, marginTop: 8 }}>
          Waiting for Claude Code data…
        </div>
      </div>
    );
  }

  const [jsonPart, tsPart] = output.split("---SPLIT---");
  let data = {};
  try {
    data = JSON.parse((jsonPart || "").trim());
  } catch (e) {
    // no valid snapshot yet
  }

  const rl = data.rate_limits || {};
  const lastUpdated = parseInt((tsPart || "").trim(), 10);
  const staleMins = lastUpdated ? Math.floor((Date.now() / 1000 - lastUpdated) / 60) : null;

  return (
    <div style={wrapperStyle}>
      <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>Claude Usage</div>
      <Row label="5-hour session" window_={rl.five_hour} />
      <Row label="7-day (weekly)" window_={rl.seven_day} />
      {staleMins !== null && staleMins > 10 && (
        <div style={{ fontSize: 10, opacity: 0.5, marginTop: 4 }}>
          ⚠ last updated {staleMins}m ago — open Claude Code to refresh
        </div>
      )}
    </div>
  );
};
