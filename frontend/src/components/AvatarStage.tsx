import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { mapBlendshapesToVrm } from '../lib/expressionMap';
import type { AvatarStageHandle, TrackingFrame } from '../types';

const HEAD_GAIN = 0.8;
const HEAD_LIMIT = 0.65;
const EXPRESSION_LERP = 0.45;

const clamp = (value: number, limit: number): number =>
  Math.max(-limit, Math.min(limit, value));

interface AvatarStageProps {
  modelUrl: string | null;
  onReady?: () => void;
  onError?: (message: string) => void;
}

const AvatarStage = forwardRef<AvatarStageHandle, AvatarStageProps>(
  ({ modelUrl, onReady, onError }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
    const sceneRef = useRef<THREE.Scene | null>(null);
    const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
    const vrmRef = useRef<VRM | null>(null);
    const headNodeRef = useRef<THREE.Object3D | null>(null);
    const expressionsRef = useRef<Record<string, number>>({});
    const targetHeadRef = useRef(new THREE.Vector3());
    const [ready, setReady] = useState(false);

    const onReadyRef = useRef(onReady);
    const onErrorRef = useRef(onError);
    onReadyRef.current = onReady;
    onErrorRef.current = onError;

    useEffect(() => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      renderer.domElement.style.display = 'block';
      container.appendChild(renderer.domElement);
      rendererRef.current = renderer;

      const scene = new THREE.Scene();
      sceneRef.current = scene;

      const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 100);
      camera.position.set(0, 1.5, 1.25);
      camera.lookAt(0, 1.42, 0);
      cameraRef.current = camera;

      const hemi = new THREE.HemisphereLight(0xffffff, 0x1c2a3a, 2.4);
      scene.add(hemi);

      const key = new THREE.DirectionalLight(0xffffff, 2.6);
      key.position.set(1.4, 2.6, 2.2);
      scene.add(key);

      const rim = new THREE.DirectionalLight(0x8be9c0, 1.1);
      rim.position.set(-1.8, 1.6, -1.4);
      scene.add(rim);

      const clock = new THREE.Clock();
      let animationFrame = 0;

      const renderLoop = () => {
        animationFrame = requestAnimationFrame(renderLoop);
        const delta = Math.min(clock.getDelta(), 0.1);
        const vrm = vrmRef.current;
        const headNode = headNodeRef.current;
        if (headNode) {
          const target = targetHeadRef.current;
          const lerp = Math.min(1, delta * 12);
          headNode.rotation.x += (target.x - headNode.rotation.x) * lerp;
          headNode.rotation.y += (target.y - headNode.rotation.y) * lerp;
          headNode.rotation.z += (target.z - headNode.rotation.z) * lerp;
        }
        vrm?.update(delta);
        renderer.render(scene, camera);
      };
      renderLoop();

      const resize = () => {
        const width = container.clientWidth || 1;
        const height = container.clientHeight || 1;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(container);

      setReady(true);

      return () => {
        setReady(false);
        cancelAnimationFrame(animationFrame);
        observer.disconnect();
        const currentVrm = vrmRef.current;
        if (currentVrm) {
          scene.remove(currentVrm.scene);
          VRMUtils.deepDispose(currentVrm.scene);
          vrmRef.current = null;
          headNodeRef.current = null;
        }
        renderer.dispose();
        renderer.domElement.remove();
        rendererRef.current = null;
        sceneRef.current = null;
        cameraRef.current = null;
      };
    }, []);

    useEffect(() => {
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (!ready || !scene || !camera || !modelUrl) {
        return;
      }

      let cancelled = false;
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));

      loader.load(
        modelUrl,
        (gltf) => {
          if (cancelled) {
            return;
          }
          const vrm = gltf.userData.vrm as VRM | undefined;
          if (!vrm) {
            onErrorRef.current?.('Loaded file is not a VRM avatar');
            return;
          }

          const previous = vrmRef.current;
          if (previous) {
            scene.remove(previous.scene);
            VRMUtils.deepDispose(previous.scene);
          }

          VRMUtils.rotateVRM0(vrm);
          vrm.scene.traverse((object) => {
            object.frustumCulled = false;
          });
          scene.add(vrm.scene);
          scene.updateMatrixWorld(true);

          vrmRef.current = vrm;
          expressionsRef.current = {};
          targetHeadRef.current.set(0, 0, 0);
          headNodeRef.current = vrm.humanoid?.getNormalizedBoneNode('head') ?? null;

          const headPosition = new THREE.Vector3(0, 1.5, 0);
          headNodeRef.current?.getWorldPosition(headPosition);
          const distance = 1.9;
          camera.position.set(headPosition.x, headPosition.y + 0.08, headPosition.z + distance);
          camera.lookAt(headPosition.x, headPosition.y - 0.08, headPosition.z);

          onReadyRef.current?.();
        },
        undefined,
        (cause) => {
          if (cancelled) {
            return;
          }
          const message = cause instanceof Error ? cause.message : 'Failed to load avatar';
          onErrorRef.current?.(message);
        },
      );

      return () => {
        cancelled = true;
      };
    }, [modelUrl, ready]);

    const applyFrame = useCallback((frame: TrackingFrame) => {
      const vrm = vrmRef.current;
      const expressionManager = vrm?.expressionManager;
      if (expressionManager) {
        const targets = mapBlendshapesToVrm(frame.blendshapes);
        for (const [name, target] of Object.entries(targets)) {
          if (!expressionManager.getExpression(name)) {
            continue;
          }
          const previous = expressionsRef.current[name] ?? 0;
          const next = previous + (target - previous) * EXPRESSION_LERP;
          expressionsRef.current[name] = next;
          expressionManager.setValue(name, next);
        }
      }

      targetHeadRef.current.set(
        clamp(frame.head.pitch * HEAD_GAIN, HEAD_LIMIT),
        clamp(-frame.head.yaw * HEAD_GAIN, HEAD_LIMIT),
        clamp(-frame.head.roll * HEAD_GAIN, HEAD_LIMIT),
      );
    }, []);

    const reset = useCallback(() => {
      const vrm = vrmRef.current;
      vrm?.expressionManager?.resetValues();
      expressionsRef.current = {};
      targetHeadRef.current.set(0, 0, 0);
      headNodeRef.current?.rotation.set(0, 0, 0);
    }, []);

    const captureStream = useCallback((fps = 30): MediaStream | null => {
      const canvas = rendererRef.current?.domElement;
      if (!canvas || typeof canvas.captureStream !== 'function') {
        return null;
      }
      return canvas.captureStream(fps);
    }, []);

    useImperativeHandle(
      ref,
      () => ({ applyFrame, reset, captureStream }),
      [applyFrame, reset, captureStream],
    );

    return <div className="avatar-stage" ref={containerRef} />;
  },
);

AvatarStage.displayName = 'AvatarStage';

export default AvatarStage;
