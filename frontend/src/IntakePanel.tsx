import { INTAKE_FIELDS, type IntakeRecord } from "@threepio/shared";

interface Props {
  intakeRecord: IntakeRecord | null;
}

/** Running notes panel: the intake fields as they fill in, plus the final care-team summary. */
export function IntakePanel({ intakeRecord }: Props) {
  const filledFields = intakeRecord
    ? INTAKE_FIELDS.filter((field) => Boolean(intakeRecord[field.key]))
    : [];
  const totalFields = INTAKE_FIELDS.length;

  return (
    <section className="panel">
      <header className="panel__header">
        <span className="eyebrow">Intake summary</span>
        <span className={intakeRecord?.finalized ? "pill pill--success" : "pill"}>
          <span className="text-mono">
            {filledFields.length}/{totalFields}
          </span>
          {intakeRecord?.finalized ? "final" : "collected"}
        </span>
      </header>

      <div className="panel__body intake-body scroll-area">
        {filledFields.length === 0 && !intakeRecord?.finalized && (
          <p className="intake-empty">Fields will fill in as the conversation progresses.</p>
        )}

        <dl className="intake-fields">
          {filledFields.map((field) => (
            <div className="field" key={field.key}>
              <dt className="field__label">{field.label}</dt>
              <dd className="field__value">{intakeRecord?.[field.key]}</dd>
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
    </section>
  );
}
