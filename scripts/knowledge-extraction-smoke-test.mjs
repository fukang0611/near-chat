import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import ExcelJS from "exceljs";

const baseUrl = process.env.NEAR_CHAT_URL ?? "http://127.0.0.1:3000";
const password = process.env.NEAR_CHAT_ADMIN_PASSWORD ?? "admin123";
const keepFixtures = process.env.NEAR_CHAT_KEEP_FIXTURES === "true";

async function request(path, { token, method = "GET", body } = {}) {
  const headers = new Headers();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (body !== undefined && !(body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `${method} ${path} returned ${response.status}: ${result?.message ?? "未知错误"}`,
    );
  }
  return result;
}

async function upload(token, name, type, bytes) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  return request("/api/files", { token, method: "POST", body: form });
}

async function waitUntilReady(token, knowledgeBaseId, documentId) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await request(`/api/knowledge-bases/${knowledgeBaseId}/documents`, { token });
    const document = result.documents.find((candidate) => candidate.id === documentId);
    if (document?.status === "READY") return document;
    if (document?.status === "FAILED") throw new Error(document.errorMessage ?? "知识文档索引失败");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new Error(`等待文档 ${documentId} 建立索引超时`);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

const glyphs = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
};

function ocrFixtureBitmap() {
  const text = "NEARCHAT OCR 2026";
  const scale = 14;
  const margin = 70;
  const width = margin * 2 + text.length * 6 * scale;
  const height = margin * 2 + 7 * scale;
  const pixels = Buffer.alloc(width * height * 3, 255);
  for (let index = 0; index < text.length; index += 1) {
    const glyph = glyphs[text[index]] ?? glyphs[" "];
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row][column] !== "1") continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = margin + (index * 6 + column) * scale + dx;
            const y = margin + row * scale + dy;
            const offset = (y * width + x) * 3;
            pixels[offset] = 18;
            pixels[offset + 1] = 18;
            pixels[offset + 2] = 18;
          }
        }
      }
    }
  }
  return { width, height, pixels };
}

/** 生成无外部依赖的高对比 PNG，让冒烟测试能验证镜像内真实 Tesseract。 */
function ocrFixturePng(bitmap) {
  const { width, height, pixels } = bitmap;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    pixels.copy(raw, y * stride + 1, y * width * 3, (y + 1) * width * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 仅包含位图 XObject 的单页 PDF，确保解析器必须经过 Poppler 与 OCR。 */
function scannedPdfFixture(bitmap) {
  const { width, height, pixels } = bitmap;
  const image = deflateSync(pixels);
  const content = Buffer.from(`q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`);
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`,
      ),
      image,
      Buffer.from("\nendstream"),
    ]),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from("endstream"),
    ]),
  ];
  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  let length = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from("\nendobj\n"),
    ]);
    parts.push(object);
    length += object.length;
  });
  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}

const suffix = Date.now().toString(36);
const marker = `NearChatPhaseTwo${suffix}`;
let token;
let knowledgeBaseId;
const attachmentIds = [];

try {
  token = (
    await request("/api/auth/login", {
      method: "POST",
      body: { username: "admin", password },
    })
  ).token;
  const created = await request("/api/knowledge-bases", {
    token,
    method: "POST",
    body: { name: `解析验收-${suffix}`, description: "自动验收后删除" },
  });
  knowledgeBaseId = created.knowledgeBase.id;

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("发布计划");
  worksheet.addRow(["版本", "标记", "状态"]);
  worksheet.addRow(["v2", marker, "准备发布"]);
  const workbookBytes = Buffer.from(new Uint8Array(await workbook.xlsx.writeBuffer()));
  const xlsxUpload = await upload(
    token,
    `phase-two-${suffix}.xlsx`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    workbookBytes,
  );
  attachmentIds.push(xlsxUpload.attachment.id);
  const xlsxAdded = await request(`/api/knowledge-bases/${knowledgeBaseId}/documents`, {
    token,
    method: "POST",
    body: { attachmentId: xlsxUpload.attachment.id },
  });

  const bitmap = ocrFixtureBitmap();
  const imageUpload = await upload(token, `ocr-${suffix}.png`, "image/png", ocrFixturePng(bitmap));
  attachmentIds.push(imageUpload.attachment.id);
  const imageAdded = await request(`/api/knowledge-bases/${knowledgeBaseId}/documents`, {
    token,
    method: "POST",
    body: { attachmentId: imageUpload.attachment.id },
  });

  const pdfUpload = await upload(
    token,
    `scan-${suffix}.pdf`,
    "application/pdf",
    scannedPdfFixture(bitmap),
  );
  attachmentIds.push(pdfUpload.attachment.id);
  const pdfAdded = await request(`/api/knowledge-bases/${knowledgeBaseId}/documents`, {
    token,
    method: "POST",
    body: { attachmentId: pdfUpload.attachment.id },
  });

  const [xlsxDocument, imageDocument, pdfDocument] = await Promise.all([
    waitUntilReady(token, knowledgeBaseId, xlsxAdded.document.id),
    waitUntilReady(token, knowledgeBaseId, imageAdded.document.id),
    waitUntilReady(token, knowledgeBaseId, pdfAdded.document.id),
  ]);
  assert.deepEqual(xlsxDocument.extraction, {
    method: "SPREADSHEET",
    worksheetCount: 1,
    rowCount: 2,
    cellCount: 6,
  });
  assert.equal(imageDocument.extraction.method, "OCR");
  assert.equal(imageDocument.extraction.pageCount, 1);
  assert.equal(imageDocument.extraction.processedPages, 1);
  assert.equal(typeof imageDocument.extraction.averageConfidence, "number");
  assert.equal(pdfDocument.extraction.method, "OCR");
  assert.equal(pdfDocument.extraction.pageCount, 1);
  assert.equal(pdfDocument.extraction.processedPages, 1);

  const search = await request(`/api/knowledge-bases/${knowledgeBaseId}/search`, {
    token,
    method: "POST",
    body: { query: marker, topK: 4 },
  });
  assert.ok(
    search.sources.some(
      (source) => source.document.id === xlsxDocument.id && source.excerpt.includes(marker),
    ),
    "structured spreadsheet marker should be searchable",
  );

  console.log(
    `NearChat knowledge extraction smoke passed: XLSX, image OCR and scanned PDF OCR are ready (${imageDocument.extraction.averageConfidence}% confidence)`,
  );
  if (keepFixtures) console.log(`Acceptance fixture retained: knowledgeBaseId=${knowledgeBaseId}`);
} finally {
  if (!keepFixtures && knowledgeBaseId && token) {
    await request(`/api/knowledge-bases/${knowledgeBaseId}`, {
      token,
      method: "DELETE",
    }).catch(() => undefined);
  }
  for (const attachmentId of keepFixtures ? [] : attachmentIds) {
    if (token) {
      await request(`/api/files/${attachmentId}`, { token, method: "DELETE" }).catch(
        () => undefined,
      );
    }
  }
}
