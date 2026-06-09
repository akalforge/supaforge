import type { ScanResult } from '../types/drift.js'

/** In-memory store for the most recent scan result (per-process). */
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
