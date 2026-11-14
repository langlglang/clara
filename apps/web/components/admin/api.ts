/** Admin requests carry the token in a header, never in a URL or log. */
export async function adminFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-clara-admin-token", token);
  return fetch(url, { ...init, headers, cache: "no-store" });
}

export async function adminJson<T>(url: string, token: string, init?: RequestInit): Promise<T> {
  const response = await adminFetch(url, token, init);
  const body = (await response.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  return body;
}
