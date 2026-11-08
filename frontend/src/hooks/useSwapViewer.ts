import { useEffect, useState, type RefObject } from 'react';

import { swapSocketUrl } from '../api';
import { drawJpegFrame } from '../lib/frame';
import type { ServerMessage, SwapConnectionStatus } from '../types';

interface UseSwapViewerOptions {
  room: string;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onError?: (message: string) => void;
}

interface UseSwapViewerResult {
  status: SwapConnectionStatus;
  error: string | null;
  viewers: number;
}

/**
 * Read-only socket used by OBS browser sources and second screens. The backend
 * keeps a single-frame mailbox per viewer, so slow consumers drop old frames
 * instead of blocking the driver.
 */
export function useSwapViewer({
  room,
  canvasRef,
  onError,
}: UseSwapViewerOptions): UseSwapViewerResult {
  const [status, setStatus] = useState<SwapConnectionStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [viewers, setViewers] = useState(0);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let closed = false;

    try {
      socket = new WebSocket(swapSocketUrl(room, 'viewer'));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setStatus('error');
      setError(message);
      onError?.(message);
      return;
    }

    socket.binaryType = 'arraybuffer';

    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (closed) {
        return;
      }
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data) as ServerMessage;
          if (message.type === 'joined') {
            setViewers(message.viewers);
            setStatus('ready');
          } else if (message.type === 'error') {
            setStatus('error');
            setError(message.message);
            onError?.(message.message);
          }
        } catch {
          // Ignore malformed status traffic.
        }
        return;
      }

      setStatus('streaming');
      const canvas = canvasRef.current;
      if (canvas) {
        void drawJpegFrame(canvas, event.data, true);
      }
    };

    socket.onerror = () => {
      if (!closed) {
        setStatus('error');
        setError('Could not connect to the swap stream.');
      }
    };

    socket.onclose = () => {
      if (!closed) {
        setStatus('error');
        setError('The swap stream closed. Is the driver running?');
      }
    };

    return () => {
      closed = true;
      socket?.close();
    };
  }, [canvasRef, onError, room]);

  return { status, error, viewers };
}
