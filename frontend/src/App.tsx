import "./App.css";
import { INTAKE_FIELD_LABELS, useRealtimeConversation } from "./useRealtimeConversation";

function App() {
  const { connectionState, transcript, error, intakeRecord, emergency, dataChannelLog, start, stop } =
    useRealtimeConversation();

  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";

  const intakeRecordFields = intakeRecord as unknown as Record<string, unknown> | null;
  const filledFields = intakeRecordFields
    ? Object.entries(INTAKE_FIELD_LABELS).filter(([key]) => Boolean(intakeRecordFields[key]))
    : [];

  return (
    <div className="app">
      <h1>Headache Intake Assistant</h1>
      <p className="subtitle">Not a diagnosis. Collects information for your care team to review before your visit.</p>

      {emergency && (
        <div className="emergency-banner" role="alert">
          <strong>Seek emergency care now.</strong> {emergency.reason} If this is a medical emergency, call 911 or go
          to the nearest emergency room.
        </div>
      )}

      {intakeRecord?.rescheduleRequested && (
        <div className="reschedule-banner" role="status">
          <strong>Reschedule requested.</strong>{" "}
          {intakeRecord.rescheduleRequested.reason || "The patient asked to be called back another time."}
        </div>
      )}

      {isConnected && !intakeRecord?.rescheduleRequested && (
        <p className="stage-indicator">
          {intakeRecord?.stage === "intake" ? "Intake in progress" : "Verifying identity…"}
        </p>
      )}

      <button
        type="button"
        className={isConnected ? "call-button call-button--active" : "call-button"}
        onClick={isConnected ? stop : start}
        disabled={isConnecting}
      >
        {isConnecting ? "Connecting…" : isConnected ? "Stop Conversation" : "Start Conversation"}
      </button>

      {error && <p className="error">{error}</p>}

      <div className="panels">
        <div className="transcript">
          {transcript.length === 0 && <p className="transcript-empty">Transcript will appear here.</p>}
          {transcript.map((turn) => (
            <div key={turn.id} className={`turn turn--${turn.role}`}>
              <span className="turn-role">{turn.role}</span>
              <span className="turn-text">{turn.text}</span>
            </div>
          ))}
        </div>

        <div className="intake-panel">
          <h2>Intake Summary</h2>
          {filledFields.length === 0 && !intakeRecord?.finalized && (
            <p className="intake-empty">Fields will fill in as the conversation progresses.</p>
          )}
          <dl className="intake-fields">
            {filledFields.map(([key, label]) => (
              <div className="intake-field" key={key}>
                <dt>{label}</dt>
                <dd>{String(intakeRecordFields?.[key])}</dd>
              </div>
            ))}
          </dl>
          {intakeRecord?.finalized && (
            <div className="intake-summary">
              <h3>Summary for care team</h3>
              <p>{intakeRecord.summary}</p>
            </div>
          )}
        </div>
      </div>

      <details className="datachannel-panel" open>
        <summary>
          Data channel events <span className="datachannel-count">({dataChannelLog.length})</span>
        </summary>
        <div className="datachannel-log">
          {dataChannelLog.length === 0 && (
            <p className="datachannel-empty">Raw events sent/received over the WebRTC data channel will appear here.</p>
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
