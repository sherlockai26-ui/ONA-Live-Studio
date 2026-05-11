/**
 * bootlog.ts — Escribe un checkpoint de arranque en consola Y en disco vía IPC.
 * Cada línea llega al log de crash en Documentos/ONA Live Studio/Logs/crash_YYYY-MM-DD.log
 * y también al terminal de Electron (RENDERER prefix).
 * Usar en el arranque para trazar dónde muere el renderer antes del crash nativo.
 */
export function bl(file: string, loc: string, msg: string): void {
  const ts = typeof performance !== 'undefined' ? performance.now().toFixed(1) : String(Date.now())
  const s  = `[BOOTLOG] ${ts} ${file}:${loc} ${msg}`
  console.log(s)
  try { (window as any).electronAPI?.crashLog?.(s) } catch (_) {}
}
