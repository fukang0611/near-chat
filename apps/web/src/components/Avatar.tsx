import { useEffect, useState } from "react";

interface AvatarProps {
  name: string;
  color: string;
  src?: string | null;
  size?: "small" | "medium" | "large";
  online?: boolean;
}

export function Avatar({ name, color, src, size = "medium", online }: AvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const initials = [...name.trim()].slice(0, 2).join("").toUpperCase() || "?";

  useEffect(() => setImageFailed(false), [src]);

  return (
    <span className={`avatar avatar-${size}`} style={{ background: color }} aria-hidden="true">
      {src && !imageFailed ? (
        <img src={src} alt="" draggable={false} onError={() => setImageFailed(true)} />
      ) : (
        initials
      )}
      {online !== undefined && <span className={`presence-dot ${online ? "is-online" : ""}`} />}
    </span>
  );
}
