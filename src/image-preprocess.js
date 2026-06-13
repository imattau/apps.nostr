export async function prepareImageFileForUpload(file, { maxSize = 1600, quality = 0.86 } = {}) {
  if (!(file instanceof Blob) || !String(file.type || "").startsWith("image/")) {
    return file;
  }

  const bitmap = await loadImageBitmap(file);
  const largestSide = Math.max(bitmap.width || 0, bitmap.height || 0);
  const scale = largestSide > maxSize ? maxSize / largestSide : 1;
  const targetWidth = Math.max(1, Math.round((bitmap.width || maxSize) * scale));
  const targetHeight = Math.max(1, Math.round((bitmap.height || maxSize) * scale));
  const canvas = createCanvas(targetWidth, targetHeight);
  const context = canvas.getContext("2d");
  if (!context) return file;
  context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
  if (typeof bitmap.close === "function") bitmap.close();

  const blob = await canvasToBlob(canvas, "image/webp", quality);
  if (!blob) return file;
  const name = replaceFileExtension(file.name || "upload", "webp");
  return new File([blob], name, { type: "image/webp", lastModified: file.lastModified || Date.now() });
}

async function loadImageBitmap(file) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file);
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Unable to decode image."));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type, quality });
  }

  return await new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function replaceFileExtension(name, extension) {
  const baseName = String(name || "upload").replace(/\.[^.]+$/, "");
  return `${baseName}.${extension}`;
}
