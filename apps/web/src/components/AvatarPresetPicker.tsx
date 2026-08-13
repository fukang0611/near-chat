import { Sparkles } from "lucide-react";
import { avatarPresets, type AvatarPreset } from "../avatar-presets";

interface AvatarPresetPickerProps {
  disabled?: boolean;
  selectingId: string | null;
  onSelect: (preset: AvatarPreset) => void;
}

/** 紧凑展示所有离线动态头像；按钮标题和 aria-label 共同服务鼠标与键盘用户。 */
export function AvatarPresetPicker({
  disabled = false,
  selectingId,
  onSelect,
}: AvatarPresetPickerProps) {
  return (
    <section className="avatar-preset-picker" aria-labelledby="avatar-preset-title">
      <div className="avatar-preset-heading">
        <span>
          <Sparkles size={14} />
        </span>
        <span>
          <strong id="avatar-preset-title">动态头像</strong>
          <small>选择后立即应用，均可离线使用</small>
        </span>
      </div>
      <ul className="avatar-preset-grid" aria-label="预设动态头像">
        {avatarPresets.map((preset) => (
          <li key={preset.id}>
            <button
              type="button"
              title={preset.label}
              aria-label={`使用动态头像：${preset.label}`}
              className={selectingId === preset.id ? "is-selecting" : ""}
              disabled={disabled}
              onClick={() => onSelect(preset)}
            >
              <img src={preset.src} alt="" loading="lazy" />
              <i aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
