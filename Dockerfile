FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
# 服务镜像只安装前后端工作区；跳过 Electron 二进制，避免桌面打包依赖进入镜像构建链路。
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci \
  --workspace @near-chat/server \
  --workspace @near-chat/web \
  --include-workspace-root

COPY apps ./apps
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 个人助理的受控浏览器工具只使用系统 Chromium，不下载 Playwright 自带浏览器。
# Noto CJK 让局域网页面的中文截图和 OCR 在无桌面环境中仍能正确显示；
# Tesseract 与 Poppler 只在图片或扫描 PDF 入库时使用，不参与核心服务健康检查。
RUN apk add --no-cache \
  chromium \
  nss \
  font-noto-cjk \
  tesseract-ocr \
  tesseract-ocr-data-chi_sim \
  tesseract-ocr-data-eng \
  poppler-utils

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

WORKDIR /app/apps/server
EXPOSE 3000
CMD ["node", "dist/index.js"]
