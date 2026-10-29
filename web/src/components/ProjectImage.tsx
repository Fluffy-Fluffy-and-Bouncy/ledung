// An image from the session's project folder (PNG or JPEG only, the server refuses the rest).
import { useState } from 'react';

export const isImagePath = (path: string): boolean => /\.(png|jpe?g)$/i.test(path.replace(/[?#].*$/, ''));

/** A "board:..." path is a board attachment from Ledung's board cache, not from the project folder. */
export const imageUrl = (sessionId: string, path: string, folder?: 'session' | 'project'): string => path.startsWith('board:')
  ? `/api/board-attachment?file=${encodeURIComponent(path)}`
  : `/api/sessions/${sessionId}/image?path=${encodeURIComponent(path)}${folder ? `&in=${folder}` : ''}`;

/** `full`: natural size (the panel scrolls); otherwise scaled down to fit. */
export function ProjectImage(props: { sessionId: string; path: string; folder?: 'session' | 'project'; alt?: string; full?: boolean; onClick?: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const src = imageUrl(props.sessionId, props.path, props.folder);
  if (problem) return <p className="error">{props.alt ? `${props.alt}: ` : ''}{problem}</p>;
  return (
    <img
      src={src}
      alt={props.alt ?? props.path}
      className={`project-image${props.full ? ' full' : ''}${props.onClick ? ' clickable' : ''}`}
      onClick={props.onClick}
      onError={() => {
        // The browser says nothing about why; the server's answer does.
        fetch(src, { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((d: { error?: string }) => setProblem(d.error ?? 'The image could not be shown.'))
          .catch(() => setProblem('The image could not be shown.'));
      }}
    />
  );
}
