import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';

import {
  deleteIdentity,
  fetchIdentities,
  fetchSwapStatus,
  identityThumbnailUrl,
  uploadIdentity,
} from './api';
import { useFaceSwap } from './hooks/useFaceSwap';
import { useSwapViewer } from './hooks/useSwapViewer';
import type {
  EngineStatus,
  IdentityInfo,
  SwapConfig,
  SwapConnectionStatus,
  SwapMode,
} from './types';

const statusLabels: Record<SwapConnectionStatus, string> = {
  idle: 'Ready',
  connecting: 'Starting…',
  ready: 'Engine ready',
  streaming: 'Live',
  error: 'Error',
};

const ROOM = 'main';

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function engineLabel(engine: EngineStatus | null): string {
  if (!engine) {
    return 'Checking engine';
  }
  if (engine.error) {
    return 'Engine error';
  }
  if (!engine.ready) {
    return 'Warming engine';
  }
  return engine.provider === 'CPUExecutionProvider' ? 'CPU ready' : 'Engine ready';
}

function DriverApp({ room }: { room: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const [identities, setIdentities] = useState<IdentityInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [recording, setRecording] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [copied, setCopied] = useState(false);

  const [seamless, setSeamless] = useState(false);
  const [strength, setStrength] = useState(1);
  const [quality, setQuality] = useState(85);
  const [mode, setMode] = useState<SwapMode>('smooth');
  const [colourMatch, setColourMatch] = useState(true);

  const selectedIdentity = useMemo(
    () => identities.find((identity) => identity.id === selectedId) ?? null,
    [identities, selectedId],
  );

  const config = useMemo<SwapConfig>(
    () => ({ mode, seamless, strength, quality, colourMatch }),
    [colourMatch, mode, quality, seamless, strength],
  );

  const swap = useFaceSwap({
    room,
    videoRef,
    canvasRef,
    identityId: selectedId,
    config,
    onError: setError,
  });

  const loadIdentities = useCallback(async () => {
    try {
      const list = await fetchIdentities();
      setIdentities(list);
      setSelectedId((current) => {
        if (current && list.some((identity) => identity.id === current)) {
          return current;
        }
        return list[0]?.id ?? null;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void loadIdentities();
  }, [loadIdentities]);

  // The backend warms the model in the background at startup. Poll until it is
  // ready (or reports a real error) so the UI can explain missing models.
  useEffect(() => {
    let active = true;
    let timer = 0;

    const check = async () => {
      try {
        const result = await fetchSwapStatus();
        if (!active) {
          return;
        }
        setEngine(result.engine);
        if (!result.engine.ready && !result.engine.error) {
          timer = window.setTimeout(check, 1_500);
        }
      } catch (cause) {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };

    void check();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  const activeEngine = swap.engine ?? engine;

  const handleSelect = (identityId: string) => {
    setSelectedId(identityId);
    setError(null);
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const identity = await uploadIdentity(file);
      await loadIdentities();
      setSelectedId(identity.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (identity: IdentityInfo) => {
    if (!window.confirm(`Delete identity "${identity.name}"?`)) {
      return;
    }
    try {
      await deleteIdentity(identity.id);
      if (selectedId === identity.id) {
        setSelectedId(null);
      }
      await loadIdentities();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const handleToggleCamera = () => {
    if (swap.running || swap.connecting) {
      swap.stop();
      return;
    }
    setError(null);
    void swap.start();
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    recorderRef.current = null;
  };

  const toggleRecording = () => {
    if (recording) {
      stopRecording();
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      setError('Start the camera and receive at least one frame before recording.');
      return;
    }

    const stream = canvas.captureStream(10);
    recordStreamRef.current = stream;
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 6_000_000,
    });

    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `vsp-swap-${Date.now()}.webm`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      recordStreamRef.current?.getTracks().forEach((track) => track.stop());
      recordStreamRef.current = null;
      setRecording(false);
    };

    recorder.start(1_000);
    recorderRef.current = recorder;
    setRecording(true);
  };

  useEffect(() => {
    return () => {
      recordStreamRef.current?.getTracks().forEach((track) => track.stop());
      recorderRef.current?.stop();
    };
  }, []);

  const viewerUrl = useMemo(() => {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('viewer', '1');
    url.searchParams.set('room', room);
    return url.toString();
  }, [room]);

  const copyViewerLink = async () => {
    try {
      await navigator.clipboard.writeText(viewerUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError('Could not copy the viewer link. Select it manually instead.');
    }
  };

  const visibleError = error ?? swap.error;
  const stageEmpty = !swap.running && !swap.stats;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>VSP Avatar</h1>
            <p>Local realtime face swap</p>
          </div>
        </div>
        <div className="topbar-status">
          <span className="engine-pill" title={activeEngine?.error ?? undefined}>
            {engineLabel(activeEngine)}
          </span>
          <div className={`status-pill status-${swap.status}`}>
            <span className="status-dot" />
            {swap.connecting ? 'Starting…' : statusLabels[swap.status]}
          </div>
        </div>
      </header>

      <main className="layout">
        <section className="stage-panel">
          <canvas ref={canvasRef} className="swap-canvas" />

          <div className="stage-chips">
            <span className="chip chip-local">100% local</span>
            {selectedIdentity && <span className="chip">{selectedIdentity.name}</span>}
            {swap.stats?.face && <span className="chip chip-face">Face detected</span>}
            {swap.running && swap.stats && swap.stats.swaps === 0 && (
              <span className="chip chip-warm">Building face…</span>
            )}
            {recording && <span className="chip chip-rec">REC</span>}
          </div>

          <video
            ref={videoRef}
            className={`webcam-preview ${showPreview && swap.running ? 'is-visible' : ''}`}
            muted
            playsInline
          />

          {stageEmpty && (
            <div className="empty-stage">
              <strong>{swap.connecting ? 'Connecting…' : 'No swap running'}</strong>
              <span>
                {identities.length === 0
                  ? 'Upload a portrait to create your first identity.'
                  : 'Choose an identity and start the camera.'}
              </span>
            </div>
          )}

          {swap.stats && (
            <div className="stage-stats">
              <span>{swap.stats.previewMs.toFixed(0)} ms preview</span>
              <span>{swap.stats.clientMs.toFixed(0)} ms round trip</span>
              <span>{swap.stats.fps.toFixed(1)} fps</span>
              <span>{swap.stats.swaps} swaps</span>
              <span>{(swap.stats.textureAgeMs / 1_000).toFixed(1)}s texture</span>
            </div>
          )}

          {swap.running && swap.stats && !swap.stats.face && (
            <div className="stage-notice">
              No face detected — center your face and improve the lighting.
            </div>
          )}

          {activeEngine?.error && <div className="stage-error">{activeEngine.error}</div>}
        </section>

        <aside className="sidebar">
          <div className="panel">
            <h2>Identity</h2>
            {identities.length > 0 ? (
              <div className="identity-grid">
                {identities.map((identity) => (
                  <div
                    key={identity.id}
                    className={`identity-card ${
                      selectedId === identity.id ? 'is-selected' : ''
                    }`}
                  >
                    <button
                      type="button"
                      className="identity-select"
                      onClick={() => handleSelect(identity.id)}
                      title={identity.name}
                    >
                      <img src={identityThumbnailUrl(identity)} alt="" />
                      <span>{identity.name}</span>
                    </button>
                    <button
                      type="button"
                      className="identity-delete"
                      onClick={() => void handleDelete(identity)}
                      aria-label={`Delete ${identity.name}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="hint">No identities yet. Upload a clear, front-facing portrait.</p>
            )}

            <label className={`upload-button ${uploading ? 'is-busy' : ''}`}>
              {uploading ? 'Processing portrait…' : 'Upload portrait'}
              <input type="file" accept="image/*" onChange={handleUpload} disabled={uploading} />
            </label>
            <p className="hint">
              The portrait is analyzed locally. One face, front-facing, good lighting works best.
            </p>
          </div>

          <div className="panel">
            <h2>Camera</h2>
            <button
              type="button"
              className={`primary ${swap.running ? 'is-stop' : ''}`}
              onClick={handleToggleCamera}
              disabled={!selectedIdentity || swap.connecting}
            >
              {swap.running ? 'Stop camera' : swap.connecting ? 'Starting…' : 'Start camera'}
            </button>
            <label className="toggle">
              <input
                type="checkbox"
                checked={showPreview}
                onChange={(event) => setShowPreview(event.target.checked)}
              />
              Show source camera
            </label>

            <label className="field">
              <span>Mode</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as SwapMode)}>
                <option value="smooth">Smooth — preview speed</option>
                <option value="exact">Exact — every frame</option>
              </select>
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={colourMatch}
                onChange={(event) => setColourMatch(event.target.checked)}
              />
              Match skin colour
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={seamless}
                onChange={(event) => setSeamless(event.target.checked)}
              />
              Seamless blending (slower)
            </label>

            <label className="slider">
              <span>
                Strength <b>{Math.round(strength * 100)}%</b>
              </span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={strength}
                onChange={(event) => setStrength(Number(event.target.value))}
              />
            </label>

            <label className="slider">
              <span>
                JPEG quality <b>{quality}</b>
              </span>
              <input
                type="range"
                min="50"
                max="95"
                step="5"
                value={quality}
                onChange={(event) => setQuality(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="panel">
            <h2>Live stats</h2>
            <dl className="stats">
              <div>
                <dt>Preview</dt>
                <dd>{swap.stats ? `${swap.stats.previewMs.toFixed(0)} ms` : '—'}</dd>
              </div>
              <div>
                <dt>Generator</dt>
                <dd>{swap.stats ? `${swap.stats.swapMs.toFixed(0)} ms` : '—'}</dd>
              </div>
              <div>
                <dt>Round trip</dt>
                <dd>{swap.stats ? `${swap.stats.clientMs.toFixed(0)} ms` : '—'}</dd>
              </div>
              <div>
                <dt>Output</dt>
                <dd>{swap.stats ? `${swap.stats.fps.toFixed(1)} fps` : '—'}</dd>
              </div>
              <div>
                <dt>Frames</dt>
                <dd>{swap.stats?.frames ?? 0}</dd>
              </div>
              <div>
                <dt>Swaps</dt>
                <dd>{swap.stats?.swaps ?? 0}</dd>
              </div>
              <div>
                <dt>Texture age</dt>
                <dd>
                  {swap.stats ? `${(swap.stats.textureAgeMs / 1_000).toFixed(1)} s` : '—'}
                </dd>
              </div>
              <div>
                <dt>Frame size</dt>
                <dd>{swap.stats ? formatBytes(swap.stats.bytes) : '—'}</dd>
              </div>
              <div>
                <dt>Face</dt>
                <dd>{swap.stats ? (swap.stats.face ? 'detected' : 'not found') : '—'}</dd>
              </div>
            </dl>
            {swap.stats && swap.stats.fps > 0 && swap.stats.fps < 5 && (
              <p className="warning">
                Output is only {swap.stats.fps.toFixed(1)} fps. Try smooth mode, or a lower
                JPEG quality.
              </p>
            )}
            {swap.stats && swap.stats.textureAgeMs > 5_000 && (
              <p className="warning">
                The generator is behind by {(swap.stats.textureAgeMs / 1_000).toFixed(1)} s;
                the cached face is being reused.
              </p>
            )}
          </div>

          <div className="panel">
            <h2>Capture &amp; output</h2>
            <button
              type="button"
              className={`primary ${recording ? 'is-record' : 'ghost'}`}
              onClick={toggleRecording}
              disabled={!swap.running}
            >
              {recording ? 'Stop recording' : 'Record result'}
            </button>
            <p className="hint">
              For OBS, add this viewer URL as a browser source. Slow viewers drop old frames
              instead of blocking the stream.
            </p>
            <div className="viewer-link">
              <input readOnly value={viewerUrl} onFocus={(event) => event.target.select()} />
              <button type="button" className="ghost" onClick={() => void copyViewerLink()}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          {visibleError && <div className="error-box">{visibleError}</div>}

          <div className="panel panel-meta">
            <h2>Pipeline</h2>
            <ul>
              <li>YuNet detector · ArcFace embedder</li>
              <li>Hyperswap 256 · ONNX Runtime CPU</li>
              <li>Smooth preview · async generator refresh</li>
              <li>One frame in flight to bound latency</li>
            </ul>
            {activeEngine?.missing && activeEngine.missing.length > 0 && (
              <p className="warning">Missing models: {activeEngine.missing.join(', ')}</p>
            )}
          </div>
        </aside>
      </main>

      <footer className="footer">
        Use only faces you own or have explicit permission to use. Disclose synthetic
        media when sharing it with other people.
      </footer>
    </div>
  );
}

function ViewerPage({ room }: { room: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handleError = useCallback((message: string) => setError(message), []);
  const viewer = useSwapViewer({ room, canvasRef, onError: handleError });

  return (
    <div className="viewer-page">
      <canvas ref={canvasRef} className="swap-canvas" />
      {error && <div className="viewer-error">{error}</div>}
      {viewer.status !== 'streaming' && (
        <div className="viewer-placeholder">
          <strong>{viewer.status === 'error' ? 'Stream unavailable' : 'Waiting for driver…'}</strong>
          <span>Room: {room}</span>
        </div>
      )}
      <div className="viewer-chip">{statusLabels[viewer.status]}</div>
    </div>
  );
}

function App() {
  const params = new URLSearchParams(window.location.search);
  const isViewer = params.get('viewer') === '1' || params.get('role') === 'viewer';
  const room = params.get('room') || ROOM;

  if (isViewer) {
    return <ViewerPage room={room} />;
  }
  return <DriverApp room={room} />;
}

export default App;
