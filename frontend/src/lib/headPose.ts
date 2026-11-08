import type { HeadPose } from '../types';

interface Landmark {
  x: number;
  y: number;
  z: number;
}

const LEFT_EYE_OUTER = 33;
const RIGHT_EYE_OUTER = 263;
const NOSE_TIP = 1;
const CHIN = 152;
const FOREHEAD = 10;

/**
 * Cheap and predictable head pose from MediaPipe face landmarks.
 * Coordinates are normalized image space (x right, y down).
 */
export function headPoseFromLandmarks(landmarks: Landmark[] | undefined): HeadPose {
  if (!landmarks || landmarks.length < 468) {
    return { yaw: 0, pitch: 0, roll: 0 };
  }

  const leftEye = landmarks[LEFT_EYE_OUTER];
  const rightEye = landmarks[RIGHT_EYE_OUTER];
  const nose = landmarks[NOSE_TIP];
  const chin = landmarks[CHIN];
  const forehead = landmarks[FOREHEAD];

  const dx = rightEye.x - leftEye.x;
  const dy = rightEye.y - leftEye.y;
  const eyeDistance = Math.max(1e-4, Math.hypot(dx, dy));
  const eyeMidX = (leftEye.x + rightEye.x) / 2;
  const eyeMidY = (leftEye.y + rightEye.y) / 2;

  const faceHeight = Math.max(
    1e-4,
    Math.hypot(chin.x - forehead.x, chin.y - forehead.y),
  );

  return {
    yaw: Math.atan((nose.x - eyeMidX) / eyeDistance),
    pitch: Math.atan((nose.y - eyeMidY) / faceHeight),
    roll: Math.atan2(dy, dx),
  };
}
