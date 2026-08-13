/**
 * 登录页的局域网消息流场景。
 *
 * 图形全部由内联 SVG 绘制，不依赖公网资源；线路与数据包动画仅承担氛围表达，
 * 不参与交互。系统开启“减少动态效果”后，移动数据包会自动隐藏。
 */
function NetworkPortrait({ variant }: { variant: "alice" | "bob" }) {
  return (
    <g transform="translate(16 17)">
      <g className={`network-portrait is-${variant}`}>
        <circle className="portrait-outline" cx="18" cy="18" r="19.5" />
        <g clipPath="url(#login-portrait-clip)">
          <circle className="portrait-bg" cx="18" cy="18" r="18" />
          <path className="portrait-body" d="M3 40c1.5-9 7.2-13.3 15-13.3S31.5 31 33 40z" />
          {variant === "alice" ? (
            <>
              <path
                className="portrait-hair"
                d="M7.2 22.8C4.3 12.4 8.7 4.2 17.9 3.5c9.3-.7 14.7 7.2 11.1 19.8l-5.8 2.8-11.5-.4z"
              />
              <ellipse className="portrait-face" cx="18" cy="18.5" rx="9.2" ry="10.8" />
              <path
                className="portrait-fringe"
                d="M8.7 15.2c1.5-7.1 7.3-10 12.4-8.6 4.3 1.1 7.2 4.8 7.3 9.5-3.8-1.1-7-3.5-8.5-6.1-2 3-5.9 5.3-11.2 5.2z"
              />
              <g className="portrait-eyes">
                <path d="M12.8 19.1h2.2M21 19.1h2.2" />
              </g>
              <circle className="portrait-blush" cx="11.8" cy="22.4" r="1.4" />
              <circle className="portrait-blush" cx="24.2" cy="22.4" r="1.4" />
              <path className="portrait-smile" d="M16 22.8c1.1 1 2.9 1 4 0" />
            </>
          ) : (
            <>
              <ellipse className="portrait-face" cx="18" cy="18.8" rx="9.6" ry="10.7" />
              <path
                className="portrait-hair"
                d="M7.7 15.7C8.1 7.8 13 3.9 19.2 4.2c5.9.2 9.6 4.1 9.4 10.6-3.1-.2-5.9-1.6-7.8-4.2-2.7 2.9-7.5 4.8-13.1 5.1z"
              />
              <g className="portrait-eyes">
                <circle cx="13.7" cy="19.2" r=".8" />
                <circle cx="22.3" cy="19.2" r=".8" />
              </g>
              <g className="portrait-glasses">
                <circle cx="13.8" cy="19" r="3.2" />
                <circle cx="22.2" cy="19" r="3.2" />
                <path d="M17 18.7h2" />
              </g>
              <path className="portrait-smile" d="M15.8 23.5c1.2.8 3.2.8 4.4 0" />
            </>
          )}
          <ellipse className="portrait-light" cx="9" cy="8" rx="5" ry="8" />
        </g>
        <g className="portrait-sparkle">
          <path d="M34 3v4M32 5h4" />
          <circle cx="30.5" cy="1.8" r="1" />
        </g>
      </g>
    </g>
  );
}

export function LoginNetworkVisual() {
  return (
    <div className="login-network-visual" aria-hidden="true">
      <div className="network-visual-meta">
        <span>
          <i />3 个成员在线
        </span>
        <small>LOCAL NETWORK</small>
      </div>

      <svg
        className="login-network-art"
        viewBox="0 0 560 328"
        preserveAspectRatio="xMidYMid meet"
        role="presentation"
      >
        <defs>
          <pattern id="login-network-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle className="network-grid-dot" cx="1.5" cy="1.5" r="1.2" />
          </pattern>
          <clipPath id="login-portrait-clip">
            <circle cx="18" cy="18" r="18" />
          </clipPath>
        </defs>

        <rect className="network-frame" x="1" y="1" width="558" height="326" rx="31" />
        <rect
          className="network-grid"
          x="2"
          y="2"
          width="556"
          height="324"
          rx="30"
          fill="url(#login-network-grid)"
        />
        <circle className="network-hub-glow" cx="280" cy="165" r="112" />

        <g className="network-routes">
          <path d="M174 142 C145 118 130 99 113 87" />
          <path d="M386 142 C415 118 430 99 447 87" />
          <path d="M174 201 C143 221 131 244 112 263" />
          <path d="M386 201 C417 221 429 244 448 263" />
        </g>

        <g className="network-packets">
          <circle className="network-packet is-violet" r="4.5">
            <animateMotion
              dur="4.2s"
              begin="-0.7s"
              repeatCount="indefinite"
              path="M113 87 C130 99 145 118 174 142"
            />
          </circle>
          <circle className="network-packet is-green" r="4">
            <animateMotion
              dur="4.8s"
              begin="-2.1s"
              repeatCount="indefinite"
              path="M386 142 C415 118 430 99 447 87"
            />
          </circle>
          <circle className="network-packet is-coral" r="4">
            <animateMotion
              dur="5s"
              begin="-1.4s"
              repeatCount="indefinite"
              path="M112 263 C131 244 143 221 174 201"
            />
          </circle>
          <circle className="network-packet is-violet" r="4.5">
            <animateMotion
              dur="4.5s"
              begin="-3.2s"
              repeatCount="indefinite"
              path="M386 201 C417 221 429 244 448 263"
            />
          </circle>
        </g>

        <g className="network-node network-person" transform="translate(24 52)">
          <rect width="138" height="70" rx="21" />
          <NetworkPortrait variant="alice" />
          <text className="network-node-title" x="62" y="31">
            林小满
          </text>
          <text className="network-node-caption" x="62" y="49">
            在线
          </text>
          <circle className="network-presence" cx="47" cy="49" r="4.5" />
        </g>

        <g className="network-node network-person" transform="translate(398 52)">
          <rect width="138" height="70" rx="21" />
          <NetworkPortrait variant="bob" />
          <text className="network-node-title" x="62" y="31">
            周远
          </text>
          <text className="network-node-caption" x="62" y="49">
            在线
          </text>
          <circle className="network-presence" cx="47" cy="49" r="4.5" />
        </g>

        <g className="network-node network-file" transform="translate(24 226)">
          <rect width="148" height="72" rx="21" />
          <rect className="network-file-icon" x="16" y="17" width="38" height="38" rx="12" />
          <path d="M29 27h9l5 5v13H29zM38 27v6h5M33 38h6M33 42h6" />
          <text className="network-node-title" x="65" y="32">
            产品方案.pdf
          </text>
          <text className="network-node-caption" x="65" y="51">
            2.4 MB · 已送达
          </text>
        </g>

        <g className="network-node network-message" transform="translate(388 226)">
          <rect width="148" height="72" rx="21" />
          <rect className="network-message-icon" x="16" y="17" width="38" height="38" rx="12" />
          <path d="M27 28.5h16v10.8a4 4 0 0 1-4 4h-5.8l-5.2 3v-3.4a4 4 0 0 1-1-2.6z" />
          <circle cx="32" cy="35.5" r="1" />
          <circle cx="35.5" cy="35.5" r="1" />
          <circle cx="39" cy="35.5" r="1" />
          <text className="network-node-title" x="65" y="32">
            明早 9:30
          </text>
          <text className="network-node-caption" x="65" y="51">
            已读 · 刚刚
          </text>
        </g>

        <g className="network-hub">
          <circle className="network-hub-ring is-outer" cx="280" cy="165" r="84" />
          <circle className="network-hub-ring is-inner" cx="280" cy="165" r="72" />
          <rect className="network-hub-card" x="174" y="110" width="212" height="110" rx="31" />
          <circle className="network-hub-icon" cx="222" cy="165" r="25" />
          <g className="network-chat-symbol" transform="translate(210 153)">
            <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
            <circle cx="8" cy="11" r="1" />
            <circle cx="12" cy="11" r="1" />
            <circle cx="16" cy="11" r="1" />
          </g>
          <text className="network-hub-title" x="257" y="158">
            NearChat
          </text>
          <text className="network-hub-caption" x="257" y="179">
            局域网消息中枢
          </text>
          <circle className="network-hub-status" cx="260" cy="195" r="3.5" />
          <text className="network-hub-status-text" x="269" y="199">
            CONNECTED
          </text>
        </g>
      </svg>
    </div>
  );
}
