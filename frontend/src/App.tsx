import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { avatarFileUrl, fetchAvatars, savePreset, uploadAvatar } from './api';
import AvatarStage from './components/AvatarStage';
import { useFaceTracking } from './hooks/useFaceTracking';
import type { AvatarInfo, AvatarStageHandle, TrackerStatus } from './types';

const statusLabels: Record<TrackerStatus, string> = {
  idle: 'Ready',
  loading: 'Loading tracker',
  tracking: 'Tracking',
  error: 'Error',
};

function App() {
  const stageRef = useRef<AvatarStageHandle | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const [avatars, setAvatars] = useState<AvatarInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<TrackerStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const selectedAvatar = useMemo(
    () => avatars.find((avatar) => avatar.id === selectedId) ?? null,
    [avatars, selectedId],
  );
  const modelUrl = selectedAvatar ? avatarFileUrl(selectedAvatar) : null;

  const loadAvatars = useCallback(async () => {
    try {
      const list = await fetchAvatars();
      setAvatars(list);
      setSelectedId((current) => current ?? list[0]?.id ?? null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(`Cannot reach the FastAPI backend. ${message}`);
    }
  }, []);

  useEffect(() => {
    void loadAvatars();
  }, [loadAvatars]);

  const handleFrame = useCallback<Parameters<typeof useFaceTracking>[0]['onFrame']>(
    (frame) => {
      stageRef.current?.applyFrame(frame);
    },
    [],
  );

  const tracker = useFaceTracking({
    videoRef,
    onFrame: handleFrame,
    onStatus: (next) => {
      setStatus(next);
      if (next !== 'error') {
        setError(null);
      }
    },
    onError: (message) => setError(message),
  });

  const toggleCamera = useCallback(() => {
    if (tracker.running || tracker.loading) {
      tracker.stop();
      stageRef.current?.reset();
    } else {
      void tracker.start();
    }
  }, [tracker]);

  const handleSelect = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedId(event.target.value);
    setModelError(null);
    stageRef.current?.reset();
  };

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    setUploading(true);
    try {
      const avatar = await uploadAvatar(file);
      await loadAvatars();
      setSelectedId(avatar.id);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    } finally {
      setUploading(false);
    }
  };

  const handleSavePreset = async () => {
    if (!selectedAvatar) {
      return;
    }
    try {
      await savePreset('default', {
        avatarId: selectedAvatar.id,
        showPreview,
        headGain: 0.8,
      });
      setError(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
    }
  };

  const toggleRecording = () => {
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    const stream = stageRef.current?.captureStream(30);
    if (!stream) {
      setError('Avatar canvas is not ready to record yet.');
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9'
      : 'video/webm';
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
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
      link.download = `vsp-avatar-${Date.now()}.webm`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setRecording(false);
    };
    recorder.start(1000);
    recorderRef.current = recorder;
    setRecording(true);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>VSP Avatar</h1>
            <p>Local webcam → VRM studio</p>
          </div>
        </div>
        <div className={`status-pill status-${status}`}>
          <span className="status-dot" />
          {tracker.loading ? 'Loading tracker…' : statusLabels[status]}
        </div>
      </header>

      <main className="layout">
        <section className="stage-panel">
          <AvatarStage
            ref={stageRef}
            modelUrl={modelUrl}
            onReady={() => setModelError(null)}
            onError={(message) => setModelError(message)}
          />

          <div className="stage-chips">
            <span className="chip chip-local">100% local</span>
            {selectedAvatar && <span className="chip">{selectedAvatar.name}</span>}
            {recording && <span className="chip chip-rec">REC</span>}
          </div>

          <video
            ref={videoRef}
            className={`webcam-preview ${showPreview ? 'is-visible' : ''}`}
            muted
            playsInline
          />

          {!selectedAvatar && (
            <div className="empty-stage">
              <strong>No avatar yet</strong>
              <span>Upload a .vrm file to get started.</span>
            </div>
          )}
          {modelError && <div className="stage-error">{modelError}</div>}
        </section>

        <aside className="sidebar">
          <div className="panel">
            <h2>Avatar</h2>
            <label className="field">
              <span>Model</span>
              <select value={selectedId ?? ''} onChange={handleSelect} disabled={avatars.length === 0}>
                {avatars.length === 0 && <option value="">No avatars found</option>}
                {avatars.map((avatar) => (
                  <option key={avatar.id} value={avatar.id}>
                    {avatar.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={`upload-button ${uploading ? 'is-busy' : ''}`}>
              {uploading ? 'Uploading…' : 'Upload .vrm'}
              <input type="file" accept=".vrm,.glb,.gltf" onChange={handleUpload} />
            </label>
          </div>

          <div className="panel">
            <h2>Camera</h2>
            <button
              type="button"
              className={`primary ${tracker.running ? 'is-stop' : ''}`}
              onClick={toggleCamera}
              disabled={tracker.loading || !selectedAvatar}
            >
              {tracker.running ? 'Stop camera' : tracker.loading ? 'Starting…' : 'Start camera'}
            </button>
            <button type="button" className="ghost" onClick={() => stageRef.current?.reset()}>
              Recenter avatar
            </button>
            <label className="toggle">
              <input
                type="checkbox"
                checked={showPreview}
                onChange={(event) => setShowPreview(event.target.checked)}
              />
              Show webcam preview
            </label>
          </div>

          <div className="panel">
            <h2>Capture</h2>
            <button
              type="button"
              className={`primary ${recording ? 'is-record' : 'ghost'}`}
              onClick={toggleRecording}
              disabled={!selectedAvatar}
            >
              {recording ? 'Stop recording' : 'Record avatar'}
            </button>
            <button type="button" className="ghost" onClick={handleSavePreset} disabled={!selectedAvatar}>
              Save preset
            </button>
            <p className="hint">
              For Zoom/Meet/Discord, add the page (or an OBS browser source) to your
              virtual camera.
            </p>
          </div>

          {error && <div className="error-box">{error}</div>}

          <div className="panel panel-meta">
            <h2>Pipeline</h2>
            <ul>
              <li>MediaPipe Face Landmarker (local wasm)</li>
              <li>three.js + @pixiv/three-vrm</li>
              <li>FastAPI catalogue + presets</li>
              <li>WebSocket tracking relay ready</li>
            </ul>
          </div>
        </aside>
      </main>

      <footer className="footer">
        Character must be one you own or have rights to. Disclose AI avatars when
        talking to other people.
      </footer>
    </div>
  );
}

export default App;
