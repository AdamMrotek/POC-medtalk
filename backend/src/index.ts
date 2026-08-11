import "dotenv/config";
import cors from "cors";
import express from "express";
import { createSession } from "./intakeStore.js";
import { runSafetyCheck, runTool, sessionConfigFor } from "./runtime.js";

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:5173" }));
app.use(express.json());

const PORT = process.env.PORT ?? "3001";
const REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE ?? "marin";
const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL ?? "gpt-live-transcribe";

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/session", async (_req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY is not set on the server." });
    return;
  }

  const opening = sessionConfigFor("verification");

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
          instructions: opening.instructions,
          audio: {
            output: { voice: REALTIME_VOICE },
            input: { transcription: { model: TRANSCRIBE_MODEL } },
          },
          tools: opening.tools,
          tool_choice: "auto",
        },
      }),
    });

    const body = await upstream.text();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `OpenAI session creation failed: ${body}` });
      return;
    }

    const record = createSession();
    const upstreamJson = JSON.parse(body);
    // Deliberately no later-stage instructions here: the client gets each stage's config
    // only once the server has decided the conversation may enter that stage.
    res.json({ ...upstreamJson, sessionId: record.sessionId, record });
  } catch (err) {
    res.status(500).json({ error: `Failed to reach OpenAI: ${(err as Error).message}` });
  }
});

app.post("/api/tools/:name", (req, res) => {
  const { args, sessionId } = req.body ?? {};
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  try {
    const outcome = runTool(req.params.name, (args ?? {}) as Record<string, unknown>, sessionId);
    if (!outcome.ok) {
      res.status(outcome.status).json({ error: outcome.error, record: outcome.record });
      return;
    }
    const { ok: _ok, ...body } = outcome;
    res.json(body);
  } catch (err) {
    res.status(500).json({ error: `Tool "${req.params.name}" failed: ${(err as Error).message}` });
  }
});

app.post("/api/safety-check", (req, res) => {
  const { sessionId, text } = req.body ?? {};
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }

  const outcome = runSafetyCheck(sessionId, String(text ?? ""));
  if (!outcome.ok) {
    res.status(outcome.status).json({ error: outcome.error });
    return;
  }
  const { ok: _ok, ...body } = outcome;
  res.json(body);
});

app.listen(Number(PORT), () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
