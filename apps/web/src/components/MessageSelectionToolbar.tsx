import { CheckSquare2, Forward, ListChecks, X } from "lucide-react";

interface MessageSelectionToolbarProps {
  selectedCount: number;
  selectableCount: number;
  maxSelection: number;
  onSelectAll: () => void;
  onForward: () => void;
  onCancel: () => void;
}

/** 多选模式替换编辑器，避免用户误以为此时仍能发送新消息。 */
export function MessageSelectionToolbar({
  selectedCount,
  selectableCount,
  maxSelection,
  onSelectAll,
  onForward,
  onCancel,
}: MessageSelectionToolbarProps) {
  const allVisibleSelected =
    selectableCount > 0 && selectedCount === Math.min(selectableCount, maxSelection);

  return (
    <section className="message-selection-toolbar" role="toolbar" aria-label="多选消息操作">
      <span className="message-selection-mark" aria-hidden="true">
        <ListChecks size={19} />
      </span>
      <div>
        <strong>已选择 {selectedCount} 条消息</strong>
        <small>一次最多转发 {maxSelection} 条，按原顺序发送</small>
      </div>
      <button
        type="button"
        className="message-selection-secondary"
        onClick={onSelectAll}
        disabled={allVisibleSelected || selectableCount === 0}
      >
        <CheckSquare2 size={15} />
        {allVisibleSelected ? "已全选" : "全选当前"}
      </button>
      <button
        type="button"
        className="message-selection-secondary"
        onClick={onCancel}
        aria-label="退出多选"
      >
        <X size={15} />
        取消
      </button>
      <button
        type="button"
        className="message-selection-forward"
        onClick={onForward}
        disabled={selectedCount === 0}
      >
        <Forward size={16} />
        转发
      </button>
    </section>
  );
}
