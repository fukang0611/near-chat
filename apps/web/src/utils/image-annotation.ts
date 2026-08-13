export interface AnnotationPoint {
  x: number;
  y: number;
}

export type AnnotationStroke =
  | {
      kind: "pen";
      color: string;
      points: AnnotationPoint[];
    }
  | {
      kind: "rect" | "arrow";
      color: string;
      start: AnnotationPoint;
      end: AnnotationPoint;
    };

export const MAX_ANNOTATION_DIMENSION = 4_096;

/** 限制导出画布边长，兼顾高分辨率标注和浏览器内存占用。 */
export function annotationCanvasSize(width: number, height: number) {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const scale = Math.min(1, MAX_ANNOTATION_DIMENSION / Math.max(safeWidth, safeHeight));
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

export function arrowHeadPoints(
  start: AnnotationPoint,
  end: AnnotationPoint,
  length: number,
): [AnnotationPoint, AnnotationPoint] {
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const spread = Math.PI / 6;
  return [
    {
      x: end.x - length * Math.cos(angle - spread),
      y: end.y - length * Math.sin(angle - spread),
    },
    {
      x: end.x - length * Math.cos(angle + spread),
      y: end.y - length * Math.sin(angle + spread),
    },
  ];
}

export function annotationDistance(stroke: AnnotationStroke): number {
  if (stroke.kind === "pen") {
    return stroke.points.slice(1).reduce((distance, point, index) => {
      const previous = stroke.points[index];
      return distance + Math.hypot(point.x - previous.x, point.y - previous.y);
    }, 0);
  }
  return Math.hypot(stroke.end.x - stroke.start.x, stroke.end.y - stroke.start.y);
}

/** 将结构化笔迹绘制到当前画布；调用前由组件重绘原图。 */
export function drawAnnotationStrokes(
  context: CanvasRenderingContext2D,
  strokes: AnnotationStroke[],
  width: number,
  height: number,
): void {
  const lineWidth = Math.max(3, Math.min(width, height) * 0.006);
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = lineWidth;

  for (const stroke of strokes) {
    context.strokeStyle = stroke.color;
    context.fillStyle = stroke.color;
    context.beginPath();
    if (stroke.kind === "pen") {
      const [first, ...rest] = stroke.points;
      if (!first) continue;
      context.moveTo(first.x, first.y);
      for (const point of rest) context.lineTo(point.x, point.y);
      context.stroke();
      continue;
    }
    if (stroke.kind === "rect") {
      context.strokeRect(
        stroke.start.x,
        stroke.start.y,
        stroke.end.x - stroke.start.x,
        stroke.end.y - stroke.start.y,
      );
      continue;
    }

    context.moveTo(stroke.start.x, stroke.start.y);
    context.lineTo(stroke.end.x, stroke.end.y);
    const [left, right] = arrowHeadPoints(stroke.start, stroke.end, lineWidth * 4.2);
    context.moveTo(stroke.end.x, stroke.end.y);
    context.lineTo(left.x, left.y);
    context.moveTo(stroke.end.x, stroke.end.y);
    context.lineTo(right.x, right.y);
    context.stroke();
  }
}
