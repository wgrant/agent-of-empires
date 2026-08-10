import { useEffect, useState } from "react";

interface Props {
  sessionId: string;
  filePath: string;
  onBack?: () => void;
}

/** Displays a workspace image through the authenticated, session-confined
 * byte endpoint. A blob URL is required because token authentication is
 * injected into fetch requests, not bare img navigations. */
export function FileImageViewer({ sessionId, filePath, onBack }: Props) {
  const [loaded, setLoaded] = useState<{ key: string; url: string | null; error: boolean }>({
    key: "",
    url: null,
    error: false,
  });
  const key = `${sessionId} ${filePath}`;

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    const params = new URLSearchParams({ path: filePath });
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/file/image?${params.toString()}`)
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((blob) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setLoaded({ key, url: objectUrl, error: false });
      })
      .catch(() => {
        if (!disposed) setLoaded({ key, url: null, error: true });
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, filePath, key]);

  const current = loaded.key === key ? loaded : { key, url: null, error: false };
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
        <div className="flex-1 min-h-0 overflow-auto p-3 flex items-start justify-center">
          <img src={current.url} alt={filePath} className="max-w-full h-auto object-contain" />
        </div>
      ) : (
        <div
          className={`flex-1 flex items-center justify-center ${current.error ? "text-status-error" : "text-text-dim"}`}
        >
          <span className="text-sm">{current.error ? "Failed to load image" : "Loading image..."}</span>
        </div>
      )}
    </div>
  );
}
