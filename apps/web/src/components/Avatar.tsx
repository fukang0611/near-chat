interface AvatarProps {
  name: string;
  color: string;
  size?: "small" | "medium" | "large";
  online?: boolean;
}

export function Avatar({ name, color, size = "medium", online }: AvatarProps) {
  const initials = [...name.trim()].slice(0, 2).join("").toUpperCase() || "?";
  return (
    <span className={`avatar avatar-${size}`} style={{ background: color }} aria-hidden="true">
      {initials}
      {online !== undefined && <span className={`presence-dot ${online ? "is-online" : ""}`} />}
    </span>
  );
}
