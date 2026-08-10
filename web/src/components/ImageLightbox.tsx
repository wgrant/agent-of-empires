import { useEffect, useState, type MouseEvent } from "react";
import { X } from "lucide-react";

interface ZoomableImageProps {
  src: string;
  alt: string;
  className?: string;
  fitImageClassName?: string;
  nativeImageClassName?: string;
  onError?: () => void;
}

/** An image that starts fitted to its viewport and can be toggled to native
 * pixel size. Native-size scrolling belongs to the viewport, avoiding the
 * clipped edges produced by centering an oversized image with flexbox. */
export function ZoomableImage({
  src,
  alt,
  className = "",
  fitImageClassName = "",
  nativeImageClassName = "",
  onError,
}: ZoomableImageProps) {
  const [zoomedSrc, setZoomedSrc] = useState<string | null>(null);
  const zoomed = zoomedSrc === src;

  const toggleZoom = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setZoomedSrc(zoomed ? null : src);
  };

  return (
    <div
      data-testid="zoomable-image-viewport"
      className={`${className} ${zoomed ? "overflow-auto" : "flex items-center justify-center overflow-hidden"}`}
    >
      <button
        type="button"
        aria-label={zoomed ? "Fit image to viewer" : "View image at actual size"}
        className={
          zoomed
            ? "block w-max max-w-none cursor-zoom-out"
            : "flex max-h-full max-w-full cursor-zoom-in items-center justify-center"
        }
        onClick={toggleZoom}
      >
        <img
          src={src}
          alt={alt}
          className={
            zoomed
              ? `h-auto max-w-none ${nativeImageClassName}`
              : `h-auto max-h-full max-w-full object-contain ${fitImageClassName}`
          }
          onError={onError}
        />
      </button>
    </div>
  );
}

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/** Full-screen image overlay. Click the backdrop or press Escape to close;
 * click the image to switch between fitted and native pixel size. */
export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      className="fixed inset-0 z-50 bg-black/80 p-4 animate-fade-in"
      onClick={onClose}
    >
      <ZoomableImage
        src={src}
        alt={alt}
        className="h-full w-full"
        fitImageClassName="max-h-[90vh] max-w-[90vw] rounded shadow-2xl"
        nativeImageClassName="rounded shadow-2xl"
      />
      <button
        type="button"
        aria-label="Close image viewer"
        className="absolute right-3 top-3 rounded-full bg-black/60 p-2 text-white transition-colors hover:bg-black/80"
        onClick={onClose}
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}
