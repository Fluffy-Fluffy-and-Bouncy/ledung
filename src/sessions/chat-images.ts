// Images the person pastes, drops or picks in the message box (issue #128). The page scales each one down to fit
// and uploads it before sending; Ledung checks it again here by its first bytes and its size, keeps it in the data
// folder under the session (owner-only, like other data) and names it itself, so the history can show it after a
// restart. The message then carries the names; Claude Code gets the bytes as image blocks of the user message,
// through the session host's stdin like any message, so the host needs no change and a container project gets them too.
// Only PNG, JPEG, GIF and WebP: never SVG or anything a browser could run as a page.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ChatImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Claude takes an image of up to 5 MB in base64 (issue #128), which is this many bytes. */
export const MAX_CHAT_IMAGE_BYTES = (5 * 1024 * 1024 * 3) / 4;
/** At most this many images per message. */
export const MAX_CHAT_IMAGES = 10;

const EXT: Record<ChatImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const TYPE_OF_EXT: Record<string, ChatImageType> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
/** An image's name: Ledung's own, random, with the extension of the type its bytes showed. */
const IMAGE_ID = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;
/** A session id as a folder name: never a path. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** What an image block in a user message looks like for the Agent SDK. */
export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: ChatImageType; data: string };
}

export class ChatImageError extends Error {}

/** The image type the first bytes show, or null: what the page or the file name says is never trusted. */
export function chatImageType(bytes: Buffer): ChatImageType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/** True for a name Ledung gave an image; anything else is never a path. */
export function isChatImageId(id: unknown): id is string {
  return typeof id === 'string' && IMAGE_ID.test(id);
}

export class ChatImages {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private folder(sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) throw new ChatImageError('Not a session.');
    return path.join(this.dir, sessionId);
  }

  /** Checks and keeps an uploaded image; its name is what the message carries. */
  save(sessionId: string, bytes: Buffer): { id: string; type: ChatImageType } {
    if (!bytes.length) throw new ChatImageError('The image is empty.');
    if (bytes.length > MAX_CHAT_IMAGE_BYTES) throw new ChatImageError(`The image is too large: at most ${(MAX_CHAT_IMAGE_BYTES / 1024 / 1024).toFixed(2)} MB.`);
    const type = chatImageType(bytes);
    if (!type) throw new ChatImageError('Only PNG, JPEG, GIF and WebP images can be sent.');
    const folder = this.folder(sessionId);
    // Owner-only, as the rest of the data folder (0700/0600 on macOS and Linux; the profile's own on Windows).
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    const id = `${crypto.randomBytes(16).toString('hex')}.${EXT[type]}`;
    fs.writeFileSync(path.join(folder, id), bytes, { mode: 0o600, flag: 'wx' });
    return { id, type };
  }

  /** An image of this session, checked again by its bytes; a name that isn't Ledung's is refused before any path. */
  read(sessionId: string, id: string): { bytes: Buffer; type: ChatImageType } {
    if (!isChatImageId(id)) throw new ChatImageError('Not an image of this session.');
    const folder = this.folder(sessionId);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(folder, id));
    } catch {
      throw new ChatImageError('The image is no longer there.');
    }
    const type = chatImageType(bytes);
    if (!type || type !== TYPE_OF_EXT[id.split('.')[1]!]) throw new ChatImageError('Not an image of this session.');
    return { bytes, type };
  }

  /** Whether each name is an image of this session; the message is refused otherwise. */
  check(sessionId: string, ids: unknown): string[] {
    if (ids === undefined || ids === null) return [];
    if (!Array.isArray(ids)) throw new ChatImageError('The images are not a list.');
    if (ids.length > MAX_CHAT_IMAGES) throw new ChatImageError(`At most ${MAX_CHAT_IMAGES} images per message.`);
    for (const id of ids) {
      if (!isChatImageId(id) || !fs.existsSync(path.join(this.folder(sessionId), id))) throw new ChatImageError('An image of the message is not one of this session\'s.');
    }
    return ids as string[];
  }

  /** The images as the user message's blocks for Claude Code; one that has gone missing is left out. */
  blocks(sessionId: string, ids: string[]): ImageBlock[] {
    const blocks: ImageBlock[] = [];
    for (const id of ids) {
      try {
        const { bytes, type } = this.read(sessionId, id);
        blocks.push({ type: 'image', source: { type: 'base64', media_type: type, data: bytes.toString('base64') } });
      } catch (e) {
        console.error(`Image ${id} of session ${sessionId}: ${(e as Error).message}`);
      }
    }
    return blocks;
  }
}
