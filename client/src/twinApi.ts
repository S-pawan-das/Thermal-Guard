import type { TwinResult } from "../../shared/twinTypes";

export type { Action, ActionResult, Cause, CauseReport, TwinResult, ZoneOutlook } from "../../shared/twinTypes";
export interface TwinResponse extends TwinResult { minutes: number }

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  return body as T;
}

export type Reply = { ok: true; message: string } | { ok: false; error: string };
export async function postJson(url: string, body?: unknown): Promise<Reply> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, message: (data as { message?: string }).message || "Done." } : { ok: false, error: (data as { error?: string }).error || `HTTP ${res.status}` };
  } catch {
    return { ok: false, error: "Could not reach the server." };
  }
}

/** "12 min" / "1 h 05 min" */
export function fmtMinutes(m: number): string {
  const r = Math.round(m);
  return r < 60 ? `${r} min` : `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, "0")} min`;
}
