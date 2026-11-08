export interface AvatarInfo {
  id: string;
  name: string;
  file_name: string;
  url: string;
  size_bytes: number;
  updated_at?: number | null;
}

export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface TrackingFrame {
  t: number;
  blendshapes: Record<string, number>;
  head: HeadPose;
}

export type TrackerStatus = 'idle' | 'loading' | 'tracking' | 'error';

export interface AvatarStageHandle {
  applyFrame: (frame: TrackingFrame) => void;
  reset: () => void;
  captureStream: (fps?: number) => MediaStream | null;
}
