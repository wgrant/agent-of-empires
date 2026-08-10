// Artifact images load through the auth-patched global fetch into a blob URL;
// a bare <img src> would carry no token.

import { useEffect, useState } from "react";
import { ImageLightbox } from "../ImageLightbox";

function useArtifactObjectUrl(url: string): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let created: string | null = null;
    fetch(url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((blob) => {
        if (revoked) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
      })
      .catch(() => {
        if (!revoked) setObjectUrl(null);
      });
    return () => {
      revoked = true;
      if (created) URL.revokeObjectURL(created);
      setObjectUrl(null);
    };
  }, [url]);

  return objectUrl;
}

/** Alt text stands in while loading and on failure, never a broken image. */
export function ArtifactImage({ url, alt }: { url: string; alt?: string }) {
  const objectUrl = useArtifactObjectUrl(url);
  const [open, setOpen] = useState(false);
  if (!objectUrl) {
    return <span className="acp-inert-path">{alt || "artifact"}</span>;
  }
  return (
    <>
      <button
        type="button"
        className="block cursor-zoom-in rounded"
        aria-label="View full-size image"
        onClick={() => setOpen(true)}
      >
        <img className="acp-artifact-image" src={objectUrl} alt={alt ?? ""} />
      </button>
      {open && <ImageLightbox src={objectUrl} alt={alt || "artifact image"} onClose={() => setOpen(false)} />}
    </>
  );
}
