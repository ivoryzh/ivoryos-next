/**
 * The Library's distributed workflows, from the Cloud server (/api/cloud-workflows/library).
 *
 * They used to be kept in each browser's localStorage under `cloud_saved_workflows`, so a
 * workflow saved in one browser did not exist in any other. `uploadBrowserLibrary` moves what a
 * browser still holds there up to the server, once, so nothing saved the old way is lost.
 */

export type LibraryWorkflow = {
  name: string;
  description: string;
  nodes: any[];
  edges: any[];
  created_at: number;
  updated_at: number;
};

const LEGACY_KEY = 'cloud_saved_workflows';
const ENDPOINT = '/api/cloud-workflows/library';

export async function listLibrary(): Promise<LibraryWorkflow[]> {
  const res = await fetch(ENDPOINT, { cache: 'no-store' });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Could not read the Cloud library.');
  return Array.isArray(data) ? data : [];
}

export async function saveLibraryWorkflow(w: Partial<LibraryWorkflow> & { name: string }): Promise<void> {
  const res = await fetch(ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(w),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Could not save to the Cloud library.');
}

let uploading: Promise<void> | null = null;

/**
 * Move this browser's old localStorage library to the server. A workflow the server already has
 * a newer save of is left as the server has it. The local copy is removed only once every upload
 * has succeeded, so a failure leaves it to be tried again on the next page load.
 */
export function uploadBrowserLibrary(): Promise<void> {
  if (!uploading) {
    uploading = (async () => {
      let local: any[] = [];
      try { local = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]'); } catch { return; }
      if (!Array.isArray(local) || local.length === 0) return;
      const onServer = new Map((await listLibrary()).map((w) => [w.name, w.updated_at]));
      for (const w of local) {
        if (!w?.name) continue;
        if ((onServer.get(w.name) ?? -1) >= (Number(w.updated_at) || 0)) continue;
        await saveLibraryWorkflow(w);
      }
      localStorage.removeItem(LEGACY_KEY);
    })().catch((e) => {
      console.error('Could not move this browser\'s saved workflows to Cloud:', e);
    }).finally(() => { uploading = null; });
  }
  return uploading;
}
