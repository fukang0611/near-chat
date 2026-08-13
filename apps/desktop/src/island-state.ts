export const DESKTOP_ISLAND_WIDTH = 380;
export const DESKTOP_ISLAND_HEIGHT = 600;

export interface DesktopIslandPreferences {
  enabled: boolean;
  x: number | null;
  y: number | null;
}

export interface IslandWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IslandBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_ISLAND_PREFERENCES: DesktopIslandPreferences = {
  enabled: false,
  x: null,
  y: null,
};

/** 对本机配置做容错，避免手工改坏 JSON 后创建到屏幕外。 */
export function normalizeIslandPreferences(value: unknown): DesktopIslandPreferences {
  if (!value || typeof value !== "object") return { ...DEFAULT_ISLAND_PREFERENCES };
  const record = value as Record<string, unknown>;
  return {
    enabled: record.enabled === true,
    x: Number.isFinite(record.x) ? Math.round(record.x as number) : null,
    y: Number.isFinite(record.y) ? Math.round(record.y as number) : null,
  };
}

function containsUsefulArea(workArea: IslandWorkArea, x: number, y: number): boolean {
  const visibleWidth =
    Math.min(x + DESKTOP_ISLAND_WIDTH, workArea.x + workArea.width) - Math.max(x, workArea.x);
  const visibleHeight =
    Math.min(y + DESKTOP_ISLAND_HEIGHT, workArea.y + workArea.height) - Math.max(y, workArea.y);
  return visibleWidth >= 120 && visibleHeight >= 80;
}

/** 优先恢复用户上次位置；显示器变化后回退到主屏右下角。 */
export function resolveIslandBounds(
  preferences: DesktopIslandPreferences,
  workAreas: IslandWorkArea[],
): IslandBounds {
  if (
    preferences.x !== null &&
    preferences.y !== null &&
    workAreas.some((area) => containsUsefulArea(area, preferences.x!, preferences.y!))
  ) {
    return {
      x: preferences.x,
      y: preferences.y,
      width: DESKTOP_ISLAND_WIDTH,
      height: DESKTOP_ISLAND_HEIGHT,
    };
  }

  const primary = workAreas[0] ?? { x: 0, y: 0, width: 1440, height: 900 };
  const margin = 18;
  return {
    x: primary.x + Math.max(margin, primary.width - DESKTOP_ISLAND_WIDTH - margin),
    y: primary.y + Math.max(margin, primary.height - DESKTOP_ISLAND_HEIGHT - margin),
    width: DESKTOP_ISLAND_WIDTH,
    height: DESKTOP_ISLAND_HEIGHT,
  };
}
