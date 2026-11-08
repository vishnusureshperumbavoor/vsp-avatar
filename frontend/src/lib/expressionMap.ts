/**
 * Map MediaPipe ARKit-style blendshapes to VRM 1.0 expression presets.
 * Values are clamped to [0, 1]; the stage applies temporal smoothing.
 */
export type Blendshapes = Record<string, number>;
export type VrmExpressions = Record<string, number>;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const get = (blendshapes: Blendshapes, key: string): number => blendshapes[key] ?? 0;

export function mapBlendshapesToVrm(blendshapes: Blendshapes): VrmExpressions {
  const smile =
    (get(blendshapes, 'mouthSmileLeft') + get(blendshapes, 'mouthSmileRight')) / 2;
  const frown =
    (get(blendshapes, 'mouthFrownLeft') + get(blendshapes, 'mouthFrownRight')) / 2;
  const browDown =
    (get(blendshapes, 'browDownLeft') + get(blendshapes, 'browDownRight')) / 2;
  const browUp =
    (get(blendshapes, 'browInnerUp') +
      get(blendshapes, 'browOuterUpLeft') +
      get(blendshapes, 'browOuterUpRight')) /
    3;

  const jawOpen = get(blendshapes, 'jawOpen');
  const pucker = get(blendshapes, 'mouthPucker');
  const funnel = get(blendshapes, 'mouthFunnel');

  return {
    blinkLeft: clamp01(get(blendshapes, 'eyeBlinkLeft')),
    blinkRight: clamp01(get(blendshapes, 'eyeBlinkRight')),
    aa: clamp01(jawOpen),
    oh: clamp01(funnel * 0.85 + jawOpen * 0.1),
    ou: clamp01(pucker),
    ee: clamp01(smile * 0.6),
    ih: clamp01(
      (get(blendshapes, 'mouthUpperUpLeft') + get(blendshapes, 'mouthUpperUpRight')) / 2,
    ),
    happy: clamp01(smile),
    angry: clamp01(browDown * 0.85),
    sad: clamp01(frown * 0.7 + get(blendshapes, 'browInnerUp') * 0.3),
    surprised: clamp01(browUp * 0.6 + jawOpen * 0.35),
    relaxed: 0,
  };
}
