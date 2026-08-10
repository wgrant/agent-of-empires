import { type ReactNode, useEffect, useState } from "react";
import { ZoomableImage } from "../ImageLightbox";

interface Props {
  sessionId: string;
  filePath: string;
  onBack?: () => void;
  /** Normal diff/text viewer, shown when byte sniffing says this is not a
   * supported raster image. */
  fallback: ReactNode;
}

function loadErrorForStatus(status: number): string {
  if (status === 404) return "File not found";
  if (status === 403) return "File is not available to this session";
  if (status === 413) return "File is too large to preview";
  return "Failed to inspect file";
}

/** Displays a workspace image through the authenticated, session-confined
 * byte endpoint. A blob URL is required because token authentication is
 * injected into fetch requests, not bare img navigations. */
export function FileImageViewer({ sessionId, filePath, onBack, fallback }: Props) {
  const [loaded, setLoaded] = useState<{
    key: string;
    url: string | null;
    error: string | null;
    notImage: boolean;
  }>({
    key: "",
    url: null,
    error: null,
    notImage: false,
  });
  const key = `${sessionId} ${filePath}`;

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    const params = new URLSearchParams({ path: filePath });
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/file/image?${params.toString()}`)
      .then((response) => {
        if (response.ok) return response.blob();
        if (response.status === 415) {
          if (!disposed) setLoaded({ key, url: null, error: null, notImage: true });
          return null;
        }
        return Promise.reject(new Error(loadErrorForStatus(response.status)));
      })
      .then((blob) => {
        if (disposed || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ key, url: objectUrl, error: null, notImage: false });
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setLoaded({
            key,
            url: null,
            error: error instanceof Error ? error.message : "Failed to inspect file",
            notImage: false,
          });
        }
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, filePath, key]);

  const current = loaded.key === key ? loaded : { key, url: null, error: null, notImage: false };
  if (current.notImage) return fallback;
  return (
    <div className="flex-1 flex flex-col bg-surface-900 overflow-hidden">
      <div className="px-3 py-2 border-b border-surface-700/20 flex items-center gap-2 shrink-0">
        {onBack && (
          <button
            onClick={onBack}
            className="text-text-dim hover:text-text-secondary cursor-pointer transition-colors flex items-center gap-1 text-[11px]"
            title="Back to transcript"
            aria-label="Back to transcript"
          >
            <span aria-hidden>←</span>
            <span className="hidden sm:inline">Transcript</span>
          </button>
        )}
        <span className="font-mono text-[12px] text-text-primary truncate">{filePath}</span>
      </div>
      {current.url ? (
        <ZoomableImage
          src={current.url}
          alt={filePath}
          className="flex-1 min-h-0 p-3"
          onError={() =>
            setLoaded((value) => (value.key === key ? { ...value, url: null, error: "Could not decode image" } : value))
          }
        />
      ) : (
        <div
          className={`flex-1 flex items-center justify-center ${current.error ? "text-status-error" : "text-text-dim"}`}
        >
          <span className="text-sm">{current.error ?? "Loading image..."}</span>
        </div>
      )}
    </div>
  );
}
