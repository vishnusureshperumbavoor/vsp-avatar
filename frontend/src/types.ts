export interface IdentityInfo {
  id: string;
  name: string;
  thumbnail_url: string;
  created_at: number;
  face_box: number[] | null;
}

export interface EngineStatus {
  ready: boolean;
  error: string | null;
  provider: string;
  missing: string[];
  models: Record<string, number>;
}

export interface SwapStatusResponse {
  engine: EngineStatus;
  streams: number;
  viewers: Record<string, number>;
}

export interface HealthResponse {
  status: string;
  version: string;
  engine_ready: boolean;
  engine_error: string | null;
  provider: string;
  missing_models: string[];
}

export type SwapMode = 'smooth' | 'exact';

export type SwapConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'streaming'
  | 'error';

export interface SwapSettings {
  mode: SwapMode;
  seamless: boolean;
  strength: number;
  quality: number;
  colour_match: boolean;
}

export interface SwapStats {
  /** Fast compositor pass for the current frame, in milliseconds. */
  previewMs: number;
  /** Latest asynchronous generator run, in milliseconds. */
  swapMs: number;
  /** Full round trip from sending a frame to receiving the swapped frame. */
  clientMs: number;
  /** Observed output rate. */
  fps: number;
  face: boolean;
  frames: number;
  swaps: number;
  bytes: number;
  mode: SwapMode;
  textureAgeMs: number;
}

export interface SwapConfig {
  mode: SwapMode;
  seamless: boolean;
  strength: number;
  quality: number;
  colourMatch: boolean;
}

interface ServerMessageBase {
  type: string;
}

export interface ServerHello extends ServerMessageBase {
  type: 'hello';
  role: string;
  room: string;
  engine: EngineStatus;
}

export interface ServerReady extends ServerMessageBase {
  type: 'ready';
  engine: EngineStatus;
  identity: string | null;
  settings?: SwapSettings;
}

export interface ServerStats extends ServerMessageBase {
  type: 'stats';
  /** Decode + detect + composite + encode time for this preview frame. */
  ms: number;
  /** Latest full generator run, in milliseconds. */
  swap_ms: number;
  swaps: number;
  texture_age_ms: number;
  face: boolean;
  n: number;
  bytes: number;
  mode: SwapMode;
}

export interface ServerJoined extends ServerMessageBase {
  type: 'joined';
  role: string;
  room: string;
  viewers: number;
}

export interface ServerError extends ServerMessageBase {
  type: 'error';
  message: string;
}

export interface ServerWarning extends ServerMessageBase {
  type: 'warning';
  message: string;
}

export interface ServerConfigAck extends ServerMessageBase {
  type: 'config';
  ok: boolean;
  mode: SwapMode;
  seamless: boolean;
  strength: number;
  quality: number;
  colour_match: boolean;
}

export interface ServerIdentityAck extends ServerMessageBase {
  type: 'identity';
  ok: boolean;
  id: string;
}

export type ServerMessage =
  | ServerHello
  | ServerReady
  | ServerStats
  | ServerJoined
  | ServerError
  | ServerWarning
  | ServerConfigAck
  | ServerIdentityAck;
