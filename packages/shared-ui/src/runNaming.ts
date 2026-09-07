// Builds a WorkflowRun's `name`. If the user typed their own experiment name, use it verbatim —
// it's what should show up as the bold, scannable label in Data History. Otherwise, fall back to
// a sequential "<prefix> #N" counter (never a random word/uuid) so back-to-back unnamed runs of
// the same kind ("Designer Run", "Optimization Run", ...) don't all render as identical labels —
// the counter is derived from how many existing runs already share that prefix.
export async function buildRunName(basePrefix: string, customName: string, apiBase: string): Promise<string> {
  const trimmed = customName.trim();
  const timestamp = new Date().toLocaleString();
  if (trimmed) return `${trimmed} - ${timestamp}`;

  let count = 0;
  try {
    const res = await fetch(`${apiBase}/api/queue/runs`);
    const data = await res.json();
    count = (data.runs || []).filter((r: any) => typeof r.name === 'string' && r.name.startsWith(basePrefix)).length;
  } catch (e) {
    // If the count lookup fails, still produce a non-random, deterministic name.
  }
  return `${basePrefix} #${count + 1} - ${timestamp}`;
}
