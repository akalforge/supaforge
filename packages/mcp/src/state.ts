import type { ScanResult } from '@akalforge/supaforge'

/** In-memory store for the most recent scan result. */
let lastScanResult: ScanResult | null = null

export function setLastScanResult(result: ScanResult): void {
  lastScanResult = result
}

export function getLastScanResult(): ScanResult | null {
  return lastScanResult
}

export function clearLastScanResult(): void {
  lastScanResult = null
}
