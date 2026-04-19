import { useEffect, useMemo, useRef, useState } from "react";

const TARGET_SAMPLE_RATE = 24000;
const CHUNK_SEND_MS = 250;
const SUBTITLE_WINDOW_MS = 3500;

function getApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";
}

function getWebSocketUrl(apiBaseUrl) {
  const url = new URL(apiBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws/translate";
  url.search = "";
  return url.toString();
}

function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

async function createSystemAudioStream() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: true,
  });
  return stream;
}

function getAudioTracks(stream) {
  return stream.getAudioTracks().filter((track) => track.readyState === "live");
}

function buildRecentTranscript(entries, field, windowMs) {
  if (!entries.length) {
    return "";
  }

  const latestEndMs = entries[entries.length - 1].end_ms ?? 0;
  const recentEntries = entries.filter((entry) => {
    const endMs = entry.end_ms ?? 0;
    return latestEndMs - endMs <= windowMs;
  });

  return recentEntries
    .map((entry) => (entry[field] || "").trim())
    .filter(Boolean)
    .join(" ");
}

export default function App() {
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [sessionId, setSessionId] = useState("");
  const [history, setHistory] = useState([]);
  const [partialJapanese, setPartialJapanese] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [darkMode, setDarkMode] = useState(true);
  const [includeSystemAudio, setIncludeSystemAudio] = useState(false);
  const [downloadLinks, setDownloadLinks] = useState({ json: "", text: "" });
  const subtitleText = useMemo(
    () => buildRecentTranscript(history, "english", SUBTITLE_WINDOW_MS),
    [history],
  );
  const finalizedJapanese = useMemo(
    () => buildRecentTranscript(history, "japanese", SUBTITLE_WINDOW_MS),
    [history],
  );

  const socketRef = useRef(null);
  const audioContextRef = useRef(null);
  const workletNodeRef = useRef(null);
  const mediaStreamsRef = useRef([]);
  const sendQueueRef = useRef([]);
  const sendQueueBytesRef = useRef(0);
  const sendIntervalRef = useRef(null);
  const finalizingRef = useRef(false);

  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? "dark" : "light";
  }, [darkMode]);

  useEffect(() => {
    return () => {
      stopCapture({ closeSocket: true }).catch(() => {});
    };
  }, []);

  async function startCapture() {
    setErrorMessage("");
    setStatus("Requesting audio access");
    setHistory([]);
    setPartialJapanese("");
    setDownloadLinks({ json: "", text: "" });
    finalizingRef.current = false;

    try {
      const socket = new WebSocket(getWebSocketUrl(apiBaseUrl));
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "start",
            sampleRate: TARGET_SAMPLE_RATE,
          }),
        );
      });

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);

        if (message.type === "session.started") {
          setSessionId(message.sessionId);
          setDownloadLinks({
            json: `${apiBaseUrl}${message.downloadJsonUrl}`,
            text: `${apiBaseUrl}${message.downloadTextUrl}`,
          });
          setStatus("Connecting audio pipeline");
        }

        if (message.type === "session.ready") {
          setStatus("Listening");
        }

        if (message.type === "segment.partial") {
          setPartialJapanese(message.japanese || "");
        }

        if (message.type === "segment.final") {
          const entry = message.entry;
          setPartialJapanese("");
          setHistory((current) => [...current, entry]);
        }

        if (message.type === "session.warning") {
          setStatus(message.message);
        }

        if (message.type === "segment.error") {
          setErrorMessage(message.message || "Processing failed.");
          setStatus("Error");
        }

        if (message.type === "session.completed") {
          setStatus("Session complete");
          finalizingRef.current = false;
          if (socketRef.current?.readyState === WebSocket.OPEN) {
            socketRef.current.close();
          }
        }
      });

      socket.addEventListener("close", () => {
        socketRef.current = null;
        setIsRunning(false);
      });

      socket.addEventListener("error", () => {
        setErrorMessage("WebSocket connection failed.");
        setStatus("Error");
      });

      const microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      const extraStreams = [];
      if (includeSystemAudio) {
        try {
          const systemAudioStream = await createSystemAudioStream();
          if (getAudioTracks(systemAudioStream).length > 0) {
            extraStreams.push(systemAudioStream);
          } else {
            for (const track of systemAudioStream.getTracks()) {
              track.stop();
            }
            setErrorMessage(
              "Shared system audio stream had no audio track. Re-share a browser tab/window with audio enabled, or use the microphone input only.",
            );
          }
        } catch (error) {
          setErrorMessage("System audio sharing was skipped or not supported.");
        }
      }

      const context = new AudioContext();
      audioContextRef.current = context;
      await context.audioWorklet.addModule("/audio-processor.js");

      const workletNode = new AudioWorkletNode(context, "pcm-capture-processor", {
        processorOptions: {
          targetSampleRate: TARGET_SAMPLE_RATE,
        },
      });

      workletNode.port.onmessage = (workerEvent) => {
        const audioBuffer = workerEvent.data;
        sendQueueRef.current.push(audioBuffer);
        sendQueueBytesRef.current += audioBuffer.byteLength;
      };

      workletNodeRef.current = workletNode;

      const microphoneSource = context.createMediaStreamSource(microphoneStream);
      microphoneSource.connect(workletNode);

      for (const stream of extraStreams) {
        if (getAudioTracks(stream).length === 0) {
          continue;
        }
        const source = context.createMediaStreamSource(stream);
        source.connect(workletNode);
      }

      const silenceGain = context.createGain();
      silenceGain.gain.value = 0;
      workletNode.connect(silenceGain).connect(context.destination);

      mediaStreamsRef.current = [microphoneStream, ...extraStreams];
      sendIntervalRef.current = window.setInterval(() => {
        flushAudioQueue();
      }, CHUNK_SEND_MS);

      setIsRunning(true);
      setStatus("Listening");
    } catch (error) {
      await stopCapture({ closeSocket: true });
      setErrorMessage(error.message || "Failed to start capture.");
      setStatus("Error");
    }
  }

  function flushAudioQueue(force = false) {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    if (!force && sendQueueBytesRef.current < TARGET_SAMPLE_RATE * 2 * (CHUNK_SEND_MS / 1000)) {
      return;
    }

    if (!sendQueueRef.current.length) {
      return;
    }

    const totalBytes = sendQueueRef.current.reduce((sum, item) => sum + item.byteLength, 0);
    const merged = new Uint8Array(totalBytes);
    let offset = 0;

    for (const item of sendQueueRef.current) {
      merged.set(new Uint8Array(item), offset);
      offset += item.byteLength;
    }

    socket.send(
      JSON.stringify({
        type: "audio",
        audio: arrayBufferToBase64(merged.buffer),
      }),
    );

    sendQueueRef.current = [];
    sendQueueBytesRef.current = 0;
  }

  async function stopCapture(options = {}) {
    const { closeSocket = false } = options;

    if (sendIntervalRef.current) {
      window.clearInterval(sendIntervalRef.current);
      sendIntervalRef.current = null;
    }

    flushAudioQueue(true);

    for (const stream of mediaStreamsRef.current) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    mediaStreamsRef.current = [];

    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    if (audioContextRef.current) {
      await audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (socketRef.current?.readyState === WebSocket.OPEN && !closeSocket) {
      finalizingRef.current = true;
      setStatus("Finalizing transcript");
      socketRef.current.send(JSON.stringify({ type: "stop" }));
    }

    if (closeSocket && socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }

    if (!finalizingRef.current) {
      setIsRunning(false);
    }
  }

  async function handleToggle() {
    if (isRunning || finalizingRef.current) {
      await stopCapture();
      return;
    }
    await startCapture();
  }

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <section className="hero-card">
        <div className="hero-topbar">
          <div>
            <p className="eyebrow">Live Japanese → English translation</p>
            <h1>Ayenix Call Assist</h1>
          </div>

          <div className="toggles">
            <label className="toggle">
              <input
                type="checkbox"
                checked={showSubtitles}
                onChange={(event) => setShowSubtitles(event.target.checked)}
              />
              <span>Subtitles</span>
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={darkMode}
                onChange={(event) => setDarkMode(event.target.checked)}
              />
              <span>Dark mode</span>
            </label>
          </div>
        </div>

        <div className="control-row">
          <button className="primary-button" onClick={handleToggle}>
            {isRunning || finalizingRef.current ? "Stop" : "Start"}
          </button>

          <label className="control-pill">
            <input
              type="checkbox"
              checked={includeSystemAudio}
              onChange={(event) => setIncludeSystemAudio(event.target.checked)}
              disabled={isRunning || finalizingRef.current}
            />
            <span>Include shared system audio</span>
          </label>

          <div className="status-block">
            <span className="status-label">Status</span>
            <strong>{status}</strong>
          </div>
        </div>

        <div className="meta-row">
          <span>Pipeline: Japanese → English</span>
          <span>Target sample rate: {TARGET_SAMPLE_RATE} Hz PCM16</span>
          <span>Session: {sessionId || "Not started"}</span>
        </div>

        {showSubtitles ? (
          <div className="subtitle-card">
            <div className="language-label">Japanese → English</div>
            <div className="subtitle-stack">
              <p className="subtitle-japanese">
                {partialJapanese || finalizedJapanese || "Japanese speech will appear here first."}
              </p>
              <p className="subtitle-english">
                {subtitleText || "English subtitles will update here with low latency."}
              </p>
            </div>
          </div>
        ) : null}

        {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

        <div className="history-header">
          <h2>Transcript history</h2>
          <div className="download-links">
            <a href={downloadLinks.json || "#"} target="_blank" rel="noreferrer">
              JSON
            </a>
            <a href={downloadLinks.text || "#"} target="_blank" rel="noreferrer">
              TXT
            </a>
          </div>
        </div>

        <div className="history-list">
          {history.length === 0 ? (
            <div className="history-empty">
              Start the session to stream microphone audio, transcribe Japanese, and
              render English subtitles in real time.
            </div>
          ) : (
            history.map((entry) => (
              <article className="history-item" key={entry.segment_id}>
                <div className="history-time">
                  {formatTimestamp(entry.start_ms)} - {formatTimestamp(entry.end_ms)}
                </div>
                <p className="history-japanese">{entry.japanese}</p>
                <p className="history-english">{entry.english}</p>
              </article>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
