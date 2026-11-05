// Images for the message box (issue #128): pasted, dropped or picked, checked and scaled down here so each fits
// Claude's limit before it is uploaded. Ledung checks the bytes and the size again (src/sessions/chat-images.ts).

/** What may be sent; anything else (SVG, HEIC, PDF…) is refused plainly. */
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
/** Claude takes up to 5 MB in base64, which is this many bytes; Ledung refuses more. */
export const MAX_CHAT_IMAGE_BYTES = (5 * 1024 * 1024 * 3) / 4;
/** The longest side an image keeps: Claude scales larger ones down anyway, and many large images in one message are refused. */
export const MAX_CHAT_IMAGE_SIDE = 2000;
export const MAX_CHAT_IMAGES = 10;
export const NOT_AN_IMAGE = 'Only PNG, JPEG, GIF and WebP images can be sent.';
export const SECRETS_HINT = "Images aren't checked for secrets.";

/** The path the file viewer opens a sent image by; its route is /api/sessions/<id>/sent-images/<name>. */
export const SENT_IMAGE_PREFIX = 'sent:';
export const sentImageUrl = (sessionId: string, name: string): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/sent-images/${encodeURIComponent(name)}`;

/** The images among what was pasted or dropped; none, and plain text pastes as usual. */
export function imageFiles(list: FileList | null | undefined): File[] {
  return [...(list ?? [])].filter((f) => f.type.startsWith('image/'));
}

function load(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('The image could not be read.'));
    };
    img.src = url;
  });
}

function encode(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * The image as it is sent: unchanged when it already fits, otherwise drawn at most MAX_CHAT_IMAGE_SIDE on its longest
 * side, as PNG for PNG and GIF (sharp text in screenshots), JPEG otherwise, then as ever smaller JPEG until it fits.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (!CHAT_IMAGE_TYPES.includes(file.type)) throw new Error(`${file.name || 'This file'}: ${NOT_AN_IMAGE}`);
  const img = await load(file);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (file.size <= MAX_CHAT_IMAGE_BYTES && longest <= MAX_CHAT_IMAGE_SIDE) return file;
  let scale = Math.min(1, MAX_CHAT_IMAGE_SIDE / longest);
  for (let attempt = 0; attempt < 8; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const lossless = attempt === 0 && (file.type === 'image/png' || file.type === 'image/gif');
    const blob = await encode(canvas, lossless ? 'image/png' : 'image/jpeg', lossless ? undefined : 0.9);
    if (blob && blob.size <= MAX_CHAT_IMAGE_BYTES) return blob;
    if (attempt > 0) scale *= 0.8;
  }
  throw new Error(`${file.name || 'The image'} could not be made small enough to send.`);
}
