/** 把网络、运行时和未知异常稳定转换为可展示文案。 */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
