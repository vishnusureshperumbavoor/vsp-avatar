/**
 * Decode a JPEG/WebP frame received over the WebSocket and paint it into a
 * canvas. Keeps the canvas at the frame's native resolution; CSS scales it.
 */
export async function drawJpegFrame(
  canvas: HTMLCanvasElement,
  data: ArrayBuffer | Blob,
  mirror = false,
): Promise<void> {
  const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/jpeg' });
  const bitmap = await createImageBitmap(blob);
  if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
  }
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return;
  }
  context.save();
  if (mirror) {
    context.translate(bitmap.width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(bitmap, 0, 0);
  context.restore();
  bitmap.close();
}
