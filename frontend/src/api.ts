import type { HealthResponse, IdentityInfo, SwapStatusResponse } from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!response.ok) {
    let detail = '';
    try {
      const payload = (await response.json()) as { detail?: string };
      detail = payload.detail ? `: ${payload.detail}` : '';
    } catch {
      // The response was not JSON; the status code is enough.
    }
    throw new Error(`${init?.method ?? 'GET'} ${path} failed (${response.status})${detail}`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function fetchIdentities(): Promise<IdentityInfo[]> {
  return request<IdentityInfo[]>('/api/identities');
}

export async function uploadIdentity(file: File): Promise<IdentityInfo> {
  const body = new FormData();
  body.append('file', file);
  return request<IdentityInfo>('/api/identities', { method: 'POST', body });
}

export function deleteIdentity(identityId: string): Promise<void> {
  return request<void>(`/api/identities/${encodeURIComponent(identityId)}`, {
    method: 'DELETE',
  });
}

export function identityThumbnailUrl(identity: IdentityInfo): string {
  return `${API_BASE}${identity.thumbnail_url}`;
}

export function fetchSwapStatus(): Promise<SwapStatusResponse> {
  return request<SwapStatusResponse>('/api/swap/status');
}

export function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>('/api/health');
}

export function savePreset(name: string, data: Record<string, unknown>): Promise<unknown> {
  return request(`/api/presets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
}

export function swapSocketUrl(room: string, role: 'driver' | 'viewer'): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ role });
  return `${protocol}//${window.location.host}/ws/swap/${encodeURIComponent(room)}?${params}`;
}

export function viewerUrl(room: string): string {
  return `${window.location.origin}/?viewer=1&room=${encodeURIComponent(room)}`;
}
