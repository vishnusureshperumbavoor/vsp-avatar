import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { useCallback, useEffect, useRef, useState } from 'react';

import { headPoseFromLandmarks } from '../lib/headPose';
import type { TrackerStatus, TrackingFrame } from '../types';

const WASM_PATH = '/mediapipe/wasm';
const MODEL_PATH = '/mediapipe/face_landmarker.task';

interface UseFaceTrackingOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onFrame: (frame: TrackingFrame) => void;
  onStatus?: (status: TrackerStatus) => void;
  onError?: (message: string) => void;
}

interface UseFaceTrackingResult {
  running: boolean;
  loading: boolean;
  error: string | null;
  start: () => Promise<void>;
  stop: () => void;
}

async function createLandmarker(): Promise<FaceLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const options = {
    baseOptions: {
      modelAssetPath: MODEL_PATH,
      delegate: 'GPU' as const,
    },
    runningMode: 'VIDEO' as const,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  };

  try {
    return await FaceLandmarker.createFromOptions(fileset, options);
  } catch (error) {
    console.warn('GPU delegate unavailable, falling back to CPU', error);
    return FaceLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: { ...options.baseOptions, delegate: 'CPU' },
    });
  }
}

export function useFaceTracking({
  videoRef,
  onFrame,
  onStatus,
  onError,
}: UseFaceTrackingOptions): UseFaceTrackingResult {
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const landmarkerRef = useRef<FaceLandmarker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef(-1);

  const frameHandlerRef = useRef(onFrame);
  const statusHandlerRef = useRef(onStatus);
  const errorHandlerRef = useRef(onError);
  frameHandlerRef.current = onFrame;
  statusHandlerRef.current = onStatus;
  errorHandlerRef.current = onError;

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    lastVideoTimeRef.current = -1;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
    }
    setRunning(false);
    statusHandlerRef.current?.('idle');
  }, [videoRef]);

  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    if (running || loading) {
      return;
    }

    setError(null);
    setLoading(true);
    statusHandlerRef.current?.('loading');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();

      const landmarker = await createLandmarker();
      landmarkerRef.current = landmarker;

      const loop = () => {
        rafRef.current = requestAnimationFrame(loop);
        const currentVideo = videoRef.current;
        const currentLandmarker = landmarkerRef.current;
        if (!currentVideo || !currentLandmarker || currentVideo.readyState < 2) {
          return;
        }
        if (currentVideo.currentTime === lastVideoTimeRef.current) {
          return;
        }
        lastVideoTimeRef.current = currentVideo.currentTime;

        const result = currentLandmarker.detectForVideo(
          currentVideo,
          performance.now(),
        );
        const blendshapes: Record<string, number> = {};
        for (const category of result.faceBlendshapes?.[0]?.categories ?? []) {
          blendshapes[category.categoryName] = category.score;
        }
        frameHandlerRef.current({
          t: performance.now(),
          blendshapes,
          head: headPoseFromLandmarks(result.faceLandmarks?.[0]),
        });
      };

      setRunning(true);
      setLoading(false);
      statusHandlerRef.current?.('tracking');
      rafRef.current = requestAnimationFrame(loop);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setLoading(false);
      statusHandlerRef.current?.('error');
      errorHandlerRef.current?.(message);
      stop();
    }
  }, [loading, running, stop, videoRef]);

  useEffect(() => stop, [stop]);

  return { running, loading, error, start, stop };
}
