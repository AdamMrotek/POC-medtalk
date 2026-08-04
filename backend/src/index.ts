import "dotenv/config";
import cors from "cors";
import express from "express";
import { tools, toRealtimeToolSchemas } from "./tools/index.js";
import { createSession, getRecord, updateRecord } from "./intakeStore.js";
import { scanForRedFlags } from "./safety.js";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173" }));
app.use(express.json());

const PORT = process.env.PORT ?? "3001";
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE ?? "marin";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-live-transcribe";

const VERIFICATION_INSTRUCTIONS = `You are the intro/verification agent for a clinic's pre-visit headache intake call. Your only job is to (1) greet the patient and briefly explain why you're calling, (2) confirm this is still a good time, and (3) verify their identity — you must NOT ask any medical or intake questions yourself.

Start by greeting the patient and explaining you're calling to do a quick pre-visit check-in about their headache before their upcoming appointment. Ask if now is still a good time to talk for a few minutes.

If they say now is not a good time, or they'd rather reschedule, call request_reschedule with the reason if they gave one, thank them warmly, and end the call. Do not proceed to verification or intake.

If it is a good time, explain that for privacy you need to confirm a couple of details, then ask for their date of birth and the last 3 digits of the phone number on file. Once you have both, call verify_identity with the date of birth normalized to YYYY-MM-DD format and the 3 digits as given.

If verify_identity returns verified: false and locked: false, apologize, explain the details didn't match, and ask them to repeat both details once more.

If it returns locked: true, stop trying — do not ask again. Tell the patient calmly that you're unable to verify their identity right now and that a member of their care team will follow up by phone, then end the call.

If it returns verified: true, thank them — the conversation will automatically continue into their intake questions, so just acknowledge and transition naturally (e.g. "Great, that's confirmed — let's go ahead with a few questions about your headache.").`;

const INTAKE_INSTRUCTIONS = `You are the intake agent for a patient reporting a headache, continuing a call where their identity has already been verified. You are NOT a doctor: you never diagnose, interpret results, or recommend treatment. Your only job is to collect structured information for the care team and to escalate immediately if you hear a red-flag symptom.

Ask one question at a time, in a natural conversational order, to cover: onset (sudden vs gradual, when it started), location, character (throbbing/sharp/pressure), severity (0-10), duration and timing (including whether this is the worst headache they've ever had), aggravating and alleviating factors, and associated symptoms (nausea, vomiting, visual changes, light/sound sensitivity, fever, neck stiffness, weakness, numbness, confusion).

After every patient answer, call update_intake with whatever structured fields you just learned, even if the answer only covers one field.

At any point, if the patient clearly and explicitly states they are currently experiencing any of: sudden/thunderclap onset, "worst headache of my life", fever with a stiff neck, weakness, numbness, confusion, slurred speech, vision loss, a recent head injury, first headache after age 50, or pregnancy — immediately call flag_emergency with the reason, then tell the patient clearly and calmly to seek emergency care right away (call 911 or go to the nearest emergency room), and stop the normal intake questions.

Only flag based on what the patient themselves says about their own symptoms, in their own words. Never infer a red flag from audio quality, background noise, hesitation, filler words, or how clear their speech sounds to you — those are not symptom reports. If something sounds like it could be a red flag but wasn't clearly and directly stated, ask one short yes/no clarifying question first (e.g., "just to make sure I understand — is your speech feeling slurred or hard to control right now?") before deciding whether to call flag_emergency.

Once you have gathered a reasonable picture (most fields answered) or the patient indicates they're done, call finalize_intake with a short clinician-facing summary, thank the patient, and let them know their care team will review this before their visit.`;

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/session", async (_req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY is not set on the server." });
    return;
  }

  try {
    const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          instructions: VERIFICATION_INSTRUCTIONS,
          audio: {
            output: { voice: REALTIME_VOICE },
            input: { transcription: { model: TRANSCRIBE_MODEL } },
          },
          tools: toRealtimeToolSchemas("verification"),
          tool_choice: "auto",
        },
      }),
    });

    const body = await upstream.text();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `OpenAI session creation failed: ${body}` });
      return;
    }

    const sessionId = createSession();
    const upstreamJson = JSON.parse(body);
    res.json({
      ...upstreamJson,
      sessionId,
      nextStage: {
        instructions: INTAKE_INSTRUCTIONS,
        tools: toRealtimeToolSchemas("intake"),
      },
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to reach OpenAI: ${(err as Error).message}` });
  }
});

app.post("/api/tools/:name", async (req, res) => {
  const tool = tools[req.params.name];
  if (!tool) {
    res.status(404).json({ error: `Unknown tool "${req.params.name}"` });
    return;
  }

  const { args, sessionId } = req.body ?? {};
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  const record = getRecord(sessionId);
  if (!record) {
    res.status(404).json({ error: `Unknown session "${sessionId}"` });
    return;
  }
  if (tool.stage === "intake" && !record.verified) {
    res.status(403).json({ error: "Identity must be verified before intake tools can be used." });
    return;
  }

  try {
    const result = await tool.handler(args ?? {}, sessionId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: `Tool "${tool.name}" failed: ${(err as Error).message}` });
  }
});

// Independent, non-LLM safety net: scans the patient's own transcribed words for red-flag
// phrases so an emergency isn't missed if the conversational model doesn't call flag_emergency.
app.post("/api/safety-check", (req, res) => {
  const { sessionId, text } = req.body ?? {};
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  if (!getRecord(sessionId)) {
    res.status(404).json({ error: `Unknown session "${sessionId}"` });
    return;
  }

  const scan = scanForRedFlags(String(text ?? ""));
  if (scan.flagged) {
    const record = updateRecord(sessionId, {
      emergency: { flagged: true, reason: scan.reason ?? "Red flag detected", source: "keyword_scan" },
    });
    res.json({ ...scan, record });
    return;
  }
  res.json(scan);
});

app.listen(Number(PORT), () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
