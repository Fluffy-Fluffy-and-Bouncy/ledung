// An MP4 from the session's project folder (issue #520), played by the browser's own player: no add-on, no codec of
// Ledung's. The server streams it in parts (Range), so it starts at once and a seek reads only from there.
import { useState } from 'react';

export const isVideoPath = (path: string): boolean => /\.mp4$/i.test(path.replace(/[?#].*$/, ''));

export const videoUrl = (sessionId: string, path: string, folder?: 'session' | 'project'): string =>
  `/api/sessions/${sessionId}/video?path=${encodeURIComponent(path)}${folder ? `&in=${folder}` : ''}`;

/** Said when the server sends the file but the browser can't decode it (HEVC on many Windows computers, say). */
export const CANT_PLAY = "This browser can't play this video. It may use a format the browser doesn't support, such as HEVC (H.265); MP4 with H.264 video plays everywhere.";
/** Said when the sound plays but there is no picture the browser can show. */
export const NO_PICTURE = "Only the sound can be played: this browser can't show the video's picture. It may use a format such as HEVC (H.265).";

/**
 * Why a <video> that failed failed: the server's own sentence when it refused the file (outside the folder, not an
 * MP4), otherwise the browser's decoding is the cause. The browser itself says nothing about which.
 */
export async function videoProblem(src: string): Promise<string> {
  try {
    const r = await fetch(src, { credentials: 'same-origin', headers: { Range: 'bytes=0-0' } });
    if (r.ok) return CANT_PLAY;
    const d = (await r.json()) as { error?: string };
    return d.error ?? 'The video could not be played.';
  } catch {
    return 'The video could not be played.';
  }
}

export function ProjectVideo(props: { sessionId: string; path: string; folder?: 'session' | 'project' }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [noPicture, setNoPicture] = useState(false);
  const src = videoUrl(props.sessionId, props.path, props.folder);
  if (problem) return <p className="error">{problem}</p>;
  return (
    <>
      {noPicture && <p className="error">{NO_PICTURE}</p>}
      <video
        src={src}
        className="project-video"
        controls
        preload="metadata"
        playsInline
        aria-label={props.path}
        onError={() => void videoProblem(src).then(setProblem)}
        // A picture the browser can't decode often still loads, with the sound and no size; say so rather than show black.
        onLoadedMetadata={(e) => setNoPicture(e.currentTarget.videoWidth === 0)}
      />
    </>
  );
}
