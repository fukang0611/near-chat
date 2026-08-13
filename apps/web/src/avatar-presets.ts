export interface AvatarPreset {
  id: string;
  label: string;
  src: string;
}

/**
 * 预设头像全部随前端包离线分发。它们是 GIF 原图，选择后仍通过标准头像接口
 * 写入 MinIO，因此网页端与 Electron 客户端的展示行为完全一致。
 */
export const avatarPresets: AvatarPreset[] = [
  { id: "coral-bob", label: "珊瑚短发", src: "/avatar-presets/coral-bob.gif" },
  { id: "teal-glasses", label: "青绿眼镜", src: "/avatar-presets/teal-glasses.gif" },
  { id: "violet-curls", label: "紫罗兰卷发", src: "/avatar-presets/violet-curls.gif" },
  { id: "blue-jacket", label: "晴空夹克", src: "/avatar-presets/blue-jacket.gif" },
  { id: "violet-cat", label: "紫铃橘猫", src: "/avatar-presets/violet-cat.gif" },
  { id: "teal-shiba", label: "薄荷柴犬", src: "/avatar-presets/teal-shiba.gif" },
  { id: "coral-rabbit", label: "珊瑚白兔", src: "/avatar-presets/coral-rabbit.gif" },
  { id: "blue-fox", label: "蓝巾赤狐", src: "/avatar-presets/blue-fox.gif" },
  { id: "violet-robot", label: "紫光机器人", src: "/avatar-presets/violet-robot.gif" },
  { id: "mint-spirit", label: "薄荷精灵", src: "/avatar-presets/mint-spirit.gif" },
  { id: "coral-explorer", label: "珊瑚探索者", src: "/avatar-presets/coral-explorer.gif" },
  { id: "blue-cloud", label: "星星云朵", src: "/avatar-presets/blue-cloud.gif" },
  { id: "violet-silver", label: "紫衣银发", src: "/avatar-presets/violet-silver.gif" },
  { id: "teal-senior", label: "青绿前辈", src: "/avatar-presets/teal-senior.gif" },
  { id: "blue-ponytail", label: "蓝衣马尾", src: "/avatar-presets/blue-ponytail.gif" },
  { id: "coral-hoodie", label: "珊瑚卫衣", src: "/avatar-presets/coral-hoodie.gif" },
];
