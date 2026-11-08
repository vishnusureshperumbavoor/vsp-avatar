import type { AvatarInfo } from './types';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} failed (${response.status})`);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function fetchAvatars(): Promise<AvatarInfo[]> {
  return request<AvatarInfo[]>('/api/avatars');
}

export function avatarFileUrl(avatar: AvatarInfo): string {
  return `${API_BASE}${avatar.url}`;
}

export function savePreset(name: string, data: Record<string, unknown>): Promise<unknown> {
  return request(`/api/presets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
}

export async function uploadAvatar(file: File): Promise<AvatarInfo> {
  const body = new FormData();
  body.append('file', file);
  const response = await fetch(`${API_BASE}/api/avatars`, { method: 'POST', body });
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status})`);
  }
  return (await response.json()) as AvatarInfo;
}
