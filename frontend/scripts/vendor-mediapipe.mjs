#!/usr/bin/env node
/**
 * Copy the MediaPipe Tasks Vision wasm runtime from node_modules and download
 * the Face Landmarker model once, so the app never calls a CDN at runtime.
 */
import { access, cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const wasmSource = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const mediapipeDir = path.join(root, 'public', 'mediapipe');
const wasmTarget = path.join(mediapipeDir, 'wasm');
const modelTarget = path.join(mediapipeDir, 'face_landmarker.task');
const modelUrl =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  await mkdir(mediapipeDir, { recursive: true });

  if (await exists(wasmSource)) {
    await cp(wasmSource, wasmTarget, { recursive: true });
    console.log(`copied wasm runtime -> ${path.relative(root, wasmTarget)}`);
  } else {
    console.warn(
      `wasm runtime not found at ${wasmSource}. Run "npm install" before this script.`,
    );
  }

  if (await exists(modelTarget)) {
    console.log(`model already present -> ${path.relative(root, modelTarget)}`);
    return;
  }

  console.log(`downloading face landmarker model...`);
  const response = await fetch(modelUrl);
  if (!response.ok) {
    throw new Error(`model download failed: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(modelTarget, buffer);
  console.log(`saved model (${(buffer.length / 1_048_576).toFixed(2)} MB)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
