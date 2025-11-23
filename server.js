import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import fetch from "node-fetch";

const PORT = process.env.PORT || 10000;

// These will come from Render
const ELEVEN_WS_URL = process.env.ELEVEN_WS_URL;
const ELEVEN_API_KEY = process.env.ELEVEN_API_KEY;

// New: Supabase transcript ingest URL
const SUPABASE_TRANSCRIPT_INGEST_URL =
  process.env.SUPABASE_TRANSCRIPT_INGEST_URL;

if (!ELEVEN_WS_URL || !ELEVEN_API_KEY) {
  console.error("Missing ELEVEN_WS_URL or ELEVEN_API_KEY env vars");
}

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("BellKeeper Twilio relay is running\n");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs) => {
  console.log("Twilio WebSocket connected");

  // Track callSid from Twilio "start" event
  let callSid = null;

  const elevenWs = new WebSocket(ELEVEN_WS_URL, {
    headers: {
      "xi-api-key": ELEVEN_API_KEY,
    },
  });

  elevenWs.on("open", () => {
    console.log("Connected to ElevenLabs");
  });

  elevenWs.on("error", (err) => {
    console.error("ElevenLabs WS error:", err);
  });

  elevenWs.on("close", () => {
    console.log("ElevenLabs WS closed");
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.close();
    }
  });

  // Twilio → ElevenLabs (+ send transcript stub to Supabase)
  twilioWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // Save callSid when stream starts
      if (msg.event === "start") {
        callSid = msg.start?.callSid || msg.start?.streamSid || null;
        console.log("Media stream started for callSid:", callSid);
        return;
      }

      if (
        msg.event === "media" &&
        msg.media?.payload &&
        elevenWs.readyState === WebSocket.OPEN
      ) {
        // Forward audio to ElevenLabs (existing behaviour)
        elevenWs.send(
          JSON.stringify({
            audio: msg.media.payload,
          })
        );

        // Also send a placeholder transcript line to Supabase
        if (SUPABASE_TRANSCRIPT_INGEST_URL) {
          fetch(SUPABASE_TRANSCRIPT_INGEST_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              callSid: callSid || msg.streamSid || "unknown",
              text: "[audio chunk]", // TODO: replace with real STT later
              speaker: "user",
            }),
          }).catch((err) => {
            console.error("Error posting transcript to Supabase:", err);
          });
        } else {
          console.warn(
            "SUPABASE_TRANSCRIPT_INGEST_URL not set, skipping transcript POST"
          );
        }
      }
    } catch (err) {
      console.error("Error handling Twilio message:", err);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    if (elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio WS error:", err);
    if (elevenWs.readyState === WebSocket.OPEN) {
      elevenWs.close();
    }
  });

  // ElevenLabs → Twilio
  elevenWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.audio && twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            media: {
              payload: msg.audio,
            },
          })
        );
      }
    } catch (err) {
      console.error("Error handling ElevenLabs message:", err);
    }
  });
});

server.listen(PORT, () => {
  console.log(`BellKeeper relay listening on port ${PORT}`);
});
