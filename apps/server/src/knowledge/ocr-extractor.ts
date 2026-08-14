import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface OcrRuntimeOptions {
  tesseractPath: string;
  pdftoppmPath: string;
  languages: string;
  timeoutMs: number;
  maxPages: number;
}

export interface OcrExtractionResult {
  text: string;
  pageCount: number;
  processedPages: number;
  averageConfidence: number | null;
  truncated: boolean;
}

interface OcrPage {
  text: string;
  confidence: number | null;
}

function commandError(error: unknown, label: string): Error {
  const candidate = error as { code?: string; killed?: boolean; stderr?: string; message?: string };
  if (candidate.code === "ENOENT") {
    return new Error(`${label}运行时未安装，请在服务镜像中启用 OCR 组件`);
  }
  if (candidate.killed) return new Error(`${label}处理超时，请缩小文件或降低页数`);
  const detail = (candidate.stderr || candidate.message || "执行失败")
    .replaceAll(/[/\\][^\s:]+/g, "[本地路径]")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return new Error(`${label}处理失败${detail ? `：${detail}` : ""}`);
}

/** 将 Tesseract TSV 还原为稳定的段落文本，并统计有效单词的平均置信度。 */
export function parseTesseractTsv(tsv: string): OcrPage {
  const lines = new Map<string, string[]>();
  const confidences: number[] = [];
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    if (!row.trim()) continue;
    const fields = row.split("\t");
    if (fields.length < 12 || fields[0] !== "5") continue;
    const text = fields.slice(11).join("\t").trim();
    if (!text) continue;
    const key = fields.slice(1, 5).join(":");
    const words = lines.get(key) ?? [];
    words.push(text);
    lines.set(key, words);
    const confidence = Number(fields[10]);
    if (Number.isFinite(confidence) && confidence >= 0) confidences.push(confidence);
  }
  return {
    text: [...lines.values()]
      .map((words) => words.join(" "))
      .join("\n")
      .trim(),
    confidence:
      confidences.length > 0
        ? Math.round(confidences.reduce((sum, value) => sum + value, 0) / confidences.length)
        : null,
  };
}

async function recognizeImage(imagePath: string, options: OcrRuntimeOptions): Promise<OcrPage> {
  try {
    const result = await execFile(
      options.tesseractPath,
      [imagePath, "stdout", "-l", options.languages, "--psm", "3", "tsv"],
      { timeout: options.timeoutMs, maxBuffer: 20 * 1024 * 1024, encoding: "utf8" },
    );
    return parseTesseractTsv(result.stdout);
  } catch (error) {
    throw commandError(error, "OCR");
  }
}

function numberedImage(left: string, right: string): number {
  const leftNumber = Number(left.match(/-(\d+)\.png$/)?.[1] ?? 0);
  const rightNumber = Number(right.match(/-(\d+)\.png$/)?.[1] ?? 0);
  return leftNumber - rightNumber;
}

function combinedConfidence(pages: OcrPage[]): number | null {
  const values = pages
    .map((page) => page.confidence)
    .filter((value): value is number => value !== null);
  return values.length > 0
    ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
    : null;
}

export async function extractImageWithOcr(
  buffer: Buffer,
  fileExtension: string,
  options: OcrRuntimeOptions,
): Promise<OcrExtractionResult> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "near-chat-ocr-image-"));
  try {
    const imagePath = path.join(temporaryDirectory, `source${fileExtension || ".img"}`);
    await writeFile(imagePath, buffer);
    const page = await recognizeImage(imagePath, options);
    if (!page.text) throw new Error("图片中没有识别到可索引的文字");
    const confidenceLabel = page.confidence === null ? "未知" : `${page.confidence}%`;
    return {
      text: `【OCR 图片｜平均置信度 ${confidenceLabel}】\n${page.text}`,
      pageCount: 1,
      processedPages: 1,
      averageConfidence: page.confidence,
      truncated: false,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function extractPdfWithOcr(
  buffer: Buffer,
  pageCount: number,
  options: OcrRuntimeOptions,
): Promise<OcrExtractionResult> {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "near-chat-ocr-pdf-"));
  try {
    const pdfPath = path.join(temporaryDirectory, "source.pdf");
    const pagePrefix = path.join(temporaryDirectory, "page");
    await writeFile(pdfPath, buffer);
    const processedPages = Math.min(pageCount, options.maxPages);
    try {
      await execFile(
        options.pdftoppmPath,
        ["-png", "-r", "180", "-f", "1", "-l", String(processedPages), pdfPath, pagePrefix],
        {
          timeout: options.timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          encoding: "utf8",
        },
      );
    } catch (error) {
      throw commandError(error, "扫描 PDF 渲染");
    }

    const images = (await readdir(temporaryDirectory))
      .filter((name) => /^page-\d+\.png$/.test(name))
      .sort(numberedImage);
    if (images.length === 0) throw new Error("扫描 PDF 没有可处理的页面");

    const pages: OcrPage[] = [];
    for (const image of images) {
      pages.push(await recognizeImage(path.join(temporaryDirectory, image), options));
    }
    const text = pages
      .map((page, index) => {
        const confidence = page.confidence === null ? "未知" : `${page.confidence}%`;
        return `【第 ${index + 1} 页｜OCR 置信度 ${confidence}】\n${page.text}`;
      })
      .filter((page) => page.trim())
      .join("\n\n");
    if (!text.replaceAll(/【[^】]+】/g, "").trim()) {
      throw new Error("扫描 PDF 中没有识别到可索引的文字");
    }
    return {
      text,
      pageCount,
      processedPages: images.length,
      averageConfidence: combinedConfidence(pages),
      truncated: pageCount > images.length,
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
