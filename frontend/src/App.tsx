import "./App.css";
import { ConnectionPill } from "./ConnectionPill";
import { ConversationTimeline } from "./ConversationTimeline";
import { IntakePanel } from "./IntakePanel";
import { useRealtimeConversation } from "./useRealtimeConversation";

function App() {
  const {
    connectionState,
    transcript,
    error,
    intakeRecord,
    emergency,
    dataChannelLog,
    stage,
    start,
    stop,
  } = useRealtimeConversation();

  // "ending" still holds a live connection — the button stays a hang-up so the patient can
  // cut the farewell short rather than being told to start over.
  const isConnected = connectionState === "connected" || connectionState === "ending";
  const isConnecting = connectionState === "connecting";

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="brand">Headache Intake Assistant</span>
        <ConnectionPill state={connectionState} />
      </header>

      <main className="hero">
        <h1 className="hero__title">Tell us about your headaches</h1>
        <p className="hero__lead">
          A short guided conversation that collects your history for your care team to review before
          your visit.
        </p>

        <div className="hero__actions">
          <button
            type="button"
            className={`btn btn--lg ${isConnected ? "btn--danger" : "btn--primary"}`}
            onClick={isConnected ? stop : start}
            disabled={isConnecting}
          >
            {isConnecting
              ? "Connecting…"
              : isConnected
                ? "End conversation"
                : connectionState === "ended"
                  ? "Start a new conversation"
                  : "Start conversation"}
          </button>
        </div>

        <p className="hero__note">Not a diagnosis · Reviewed by your care team</p>
      </main>

      {(emergency || intakeRecord?.rescheduleRequested || error) && (
        <div className="banner-stack">
          {emergency && (
            <div className="banner banner--danger" role="alert">
              <span>
                <strong>Seek emergency care now.</strong> {emergency.reason} If this is a medical
                emergency, call 911 or go to the nearest emergency room.
              </span>
            </div>
          )}

          {intakeRecord?.rescheduleRequested && (
            <div className="banner banner--warning" role="status">
              <span>
                <strong>Reschedule requested.</strong>{" "}
                {intakeRecord.rescheduleRequested.reason ||
                  "The patient asked to be called back another time."}
              </span>
            </div>
          )}

          {error && (
            <div className="banner banner--error" role="alert">
              <span>{error}</span>
            </div>
          )}
        </div>
      )}

      <div className="panels">
        <ConversationTimeline
          transcript={transcript}
          stage={stage}
          connectionState={connectionState}
          intakeRecord={intakeRecord}
          emergencyReason={emergency?.reason}
        />

        <IntakePanel intakeRecord={intakeRecord} />
      </div>

      <details className="devlog">
        <summary className="devlog__summary">
          <span className="eyebrow">Data channel events</span>
          <span className="devlog__count">{dataChannelLog.length}</span>
        </summary>
        <div className="devlog__log scroll-area">
          {dataChannelLog.length === 0 && (
            <p className="devlog__empty">
              Raw events sent/received over the WebRTC data channel will appear here.
            </p>
          )}
          {dataChannelLog.map((entry) =>
            entry.count !== undefined ? (
              <div key={entry.id} className={`dc-entry dc-entry--${entry.direction} dc-entry--stream`}>
                <span className="dc-entry-direction">{entry.direction === "out" ? "→ sent" : "← received"}</span>
                <span className="dc-entry-type">
                  streaming delta{entry.deltaTypes && entry.deltaTypes.length > 0 ? ` (${entry.deltaTypes.join(", ")})` : ""}
                </span>
                <span className="dc-entry-count">×{entry.count}</span>
              </div>
            ) : (
              <details key={entry.id} className={`dc-entry dc-entry--${entry.direction}`}>
                <summary className="dc-entry-header">
                  <span className="dc-entry-direction">{entry.direction === "out" ? "→ sent" : "← received"}</span>
                  <span className="dc-entry-type">{entry.type}</span>
                  <span className="dc-entry-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                </summary>
                <pre className="dc-entry-payload">{JSON.stringify(entry.payload, null, 2)}</pre>
              </details>
            )
          )}
        </div>
      </details>
    </div>
  );
}

export default App;
