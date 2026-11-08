import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { swapSocketUrl } from '../api';
import { drawJpegFrame } from '../lib/frame';
import type {
  EngineStatus,
  ServerMessage,
  SwapConfig,
  SwapConnectionStatus,
  SwapStats,
} from '../types';

interface UseFaceSwapOptions {
  room: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  identityId: string | null;
  config: SwapConfig;
  onError?: (message: string) => void;
}

interface UseFaceSwapResult {
  running: boolean;
  connecting: boolean;
  status: SwapConnectionStatus;
  error: string | null;
  stats: SwapStats | null;
  engine: EngineStatus | null;
  start: () => Promise<void>;
  stop: () => void;
}

function computeFps(times: number[], now: number): number {
  const cutoff = now - 5_000;
  while (times.length > 0 && times[0] < cutoff) {
    times.shift();
  }
  if (times.length < 2) {
    return 0;
  }
  const span = (times[times.length - 1] - times[0]) / 1_000;
  return span > 0 ? (times.length - 1) / span : 0;
}

function sendJson(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

export function useFaceSwap({
  room,
  videoRef,
  canvasRef,
  identityId,
  config,
  onError,
}: UseFaceSwapOptions): UseFaceSwapResult {
  const [running, setRunning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState<SwapConnectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<SwapStats | null>(null);
  const [engine, setEngine] = useState<EngineStatus | null>(null);

  const runningRef = useRef(false);
  const connectingRef = useRef(false);
  const cancelledRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const awaitingFrameRef = useRef(false);
  const lastSendAtRef = useRef(0);
  const sentAtRef = useRef(0);
  const lastRttRef = useRef(0);
  const receiveTimesRef = useRef<number[]>([]);

  const identityRef = useRef(identityId);
  const configRef = useRef(config);
  const errorRef = useRef(onError);
  identityRef.current = identityId;
  configRef.current = config;
  errorRef.current = onError;

  const stopMedia = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
    awaitingFrameRef.current = false;
  }, [videoRef]);

  const stop = useCallback(() => {
    cancelledRef.current = true;
    runningRef.current = false;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
    stopMedia();
    setRunning(false);
    setConnecting(false);
    setError(null);
    setStatus('idle');
  }, [stopMedia]);

  const start = useCallback(async () => {
    if (runningRef.current || connectingRef.current) {
      return;
    }

    cancelledRef.current = false;
    connectingRef.current = true;
    setConnecting(true);
    setStatus('connecting');
    setError(null);
    setStats(null);
    receiveTimesRef.current = [];
    lastSendAtRef.current = 0;
    sentAtRef.current = 0;
    lastRttRef.current = 0;
    awaitingFrameRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user',
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
      if (cancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        throw new Error('Camera preview element is not ready.');
      }
      video.srcObject = stream;
      await video.play();

      const socket = new WebSocket(swapSocketUrl(room, 'driver'));
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = window.setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          reject(new Error('The swap engine did not become ready in time.'));
        }, 30_000);

        socket.onopen = () => {
          if (identityRef.current) {
            sendJson(socket, { type: 'identity', id: identityRef.current });
          }
          sendJson(socket, {
            type: 'config',
            mode: configRef.current.mode,
            seamless: configRef.current.seamless,
            strength: configRef.current.strength,
            quality: configRef.current.quality,
            colour_match: configRef.current.colourMatch,
          });
        };

        socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
          if (typeof event.data === 'string') {
            let message: ServerMessage;
            try {
              message = JSON.parse(event.data) as ServerMessage;
            } catch {
              return;
            }

            switch (message.type) {
              case 'hello':
                setEngine(message.engine);
                break;
              case 'ready':
                setEngine(message.engine);
                if (!settled) {
                  settled = true;
                  window.clearTimeout(timeout);
                  resolve();
                }
                break;
              case 'stats': {
                const now = performance.now();
                setStats({
                  previewMs: message.ms,
                  swapMs: message.swap_ms,
                  clientMs: lastRttRef.current,
                  fps: computeFps(receiveTimesRef.current, now),
                  face: message.face,
                  frames: message.n,
                  swaps: message.swaps,
                  bytes: message.bytes,
                  mode: message.mode,
                  textureAgeMs: message.texture_age_ms,
                });
                break;
              }
              case 'error':
                awaitingFrameRef.current = false;
                errorRef.current?.(message.message);
                if (!settled) {
                  settled = true;
                  window.clearTimeout(timeout);
                  reject(new Error(message.message));
                }
                break;
              case 'warning':
                errorRef.current?.(message.message);
                break;
              default:
                break;
            }
            return;
          }

          const now = performance.now();
          receiveTimesRef.current.push(now);
          lastRttRef.current = sentAtRef.current ? now - sentAtRef.current : 0;
          awaitingFrameRef.current = false;
          setStatus('streaming');
          const canvas = canvasRef.current;
          if (canvas) {
            void drawJpegFrame(canvas, event.data, true);
          }
        };

        socket.onerror = () => {
          if (settled) {
            return;
          }
          settled = true;
          window.clearTimeout(timeout);
          reject(new Error('Could not connect to the swap WebSocket.'));
        };

        socket.onclose = () => {
          if (!settled) {
            settled = true;
            window.clearTimeout(timeout);
            reject(new Error('The swap connection closed before the engine was ready.'));
            return;
          }
          if (runningRef.current) {
            runningRef.current = false;
            stopMedia();
            setRunning(false);
            setConnecting(false);
            setStatus('error');
            setError('The swap connection closed.');
            errorRef.current?.('The swap connection closed.');
          }
        };
      });

      if (cancelledRef.current) {
        return;
      }

      runningRef.current = true;
      setRunning(true);
      setConnecting(false);
      setStatus('ready');

      const pump = () => {
        if (!runningRef.current) {
          return;
        }
        rafRef.current = requestAnimationFrame(pump);

        const video = videoRef.current;
        const socket = socketRef.current;
        if (
          !video ||
          !socket ||
          socket.readyState !== WebSocket.OPEN ||
          video.readyState < 2 ||
          video.videoWidth === 0 ||
          video.videoHeight === 0
        ) {
          return;
        }

        // One frame in flight at a time; this bounds latency and prevents a
        // backlog when the generator is slower than the preview pipeline.
        if (awaitingFrameRef.current) {
          return;
        }
        const now = performance.now();
        if (now - lastSendAtRef.current < 50) {
          return;
        }

        let capture = captureCanvasRef.current;
        if (!capture) {
          capture = document.createElement('canvas');
          captureCanvasRef.current = capture;
        }
        if (capture.width !== video.videoWidth || capture.height !== video.videoHeight) {
          capture.width = video.videoWidth;
          capture.height = video.videoHeight;
        }
        const context = capture.getContext('2d');
        if (!context) {
          return;
        }
        context.drawImage(video, 0, 0, capture.width, capture.height);

        awaitingFrameRef.current = true;
        lastSendAtRef.current = now;
        const quality = Math.min(0.95, Math.max(0.4, configRef.current.quality / 100));
        capture.toBlob(
          (blob) => {
            const activeSocket = socketRef.current;
            if (
              !blob ||
              !activeSocket ||
              activeSocket.readyState !== WebSocket.OPEN ||
              !runningRef.current
            ) {
              awaitingFrameRef.current = false;
              return;
            }
            sentAtRef.current = performance.now();
            try {
              activeSocket.send(blob);
            } catch {
              awaitingFrameRef.current = false;
            }
          },
          'image/jpeg',
          quality,
        );
      };

      rafRef.current = requestAnimationFrame(pump);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      runningRef.current = false;
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState < WebSocket.CLOSING) {
        socket.close();
      }
      stopMedia();
      setConnecting(false);
      setRunning(false);
      if (!cancelledRef.current) {
        setStatus('error');
        setError(message);
        errorRef.current?.(message);
      }
    } finally {
      connectingRef.current = false;
    }
  }, [canvasRef, room, stopMedia, videoRef]);

  // Live identity changes are control messages; the stream stays connected.
  useEffect(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN && identityId) {
      sendJson(socket, { type: 'identity', id: identityId });
    }
  }, [identityId]);

  // Same for rendering options.
  useEffect(() => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      sendJson(socket, {
        type: 'config',
        mode: config.mode,
        seamless: config.seamless,
        strength: config.strength,
        quality: config.quality,
        colour_match: config.colourMatch,
      });
    }
  }, [config.colourMatch, config.mode, config.quality, config.seamless, config.strength]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      runningRef.current = false;
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
      stopMedia();
    };
  }, [stopMedia]);

  return { running, connecting, status, error, stats, engine, start, stop };
}
