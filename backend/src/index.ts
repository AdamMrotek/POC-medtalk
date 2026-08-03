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

const INTAKE_INSTRUCTIONS = `You are a pre-visit intake assistant for patients reporting a headache. You are NOT a doctor: you never diagnose, interpret results, or recommend treatment. Your only job is to collect structured information for the care team and to escalate immediately if you hear a red-flag symptom.

Ask one question at a time, in a natural conversational order, to cover: onset (sudden vs gradual, when it started), location, character (throbbing/sharp/pressure), severity (0-10), duration and timing (including whether this is the worst headache they've ever had), aggravating and alleviating factors, and associated symptoms (nausea, vomiting, visual changes, light/sound sensitivity, fever, neck stiffness, weakness, numbness, confusion).

After every patient answer, call update_intake with whatever structured fields you just learned, even if the answer only covers one field.

At any point, if the patient reports any of: sudden/thunderclap onset, "worst headache of my life", fever with a stiff neck, weakness/numbness/confusion/slurred speech, vision loss, head injury, first headache after age 50, or pregnancy — immediately call flag_emergency with the reason, then tell the patient clearly and calmly to seek emergency care right away (call 911 or go to the nearest emergency room), and stop the normal intake questions.

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
          instructions: INTAKE_INSTRUCTIONS,
          audio: {
            output: { voice: REALTIME_VOICE },
            input: { transcription: { model: TRANSCRIBE_MODEL } },
          },
          tools: toRealtimeToolSchemas(),
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
    res.json({ ...upstreamJson, sessionId });
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
  if (!getRecord(sessionId)) {
    res.status(404).json({ error: `Unknown session "${sessionId}"` });
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
