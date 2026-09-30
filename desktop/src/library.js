'use strict';
// Workflows added to a deck from outside it: templates from the Hub, and the ones a platform ships.
//
// A deck's workflow library belongs to its edge (edge_server/ivoryos_edge/workflows.py). While the
// edge runs, a workflow is saved through its API, the same path as a save in the Designer, so it
// is versioned and published to Cloud like any other. While it is stopped, the file is written
// into the library folder instead; the edge adopts a file it finds there as version 1 the next time
// it reads its library (`_sync_from_disk`), which is a documented way in, not a back door.
//
// Nothing is checked against the deck: a template written for other instruments is still a valid
// workflow, and the edge's Library marks the steps this deck cannot run.

const fs = require('node:fs');
const path = require('node:path');

class LibraryError extends Error {}

/** The edge's own rule (workflows.validate_name): a file name, so no separators, no leading dot. */
function cleanWorkflowName(name) {
    const clean = String(name || '').replace(/[\\/\0]/g, '-').replace(/^\.+/, '').trim();
    return clean || 'Hub template';
}

/** `name` if it is free in `existing`, else `name (2)`, `name (3)`, ..., compared without case. */
function freeWorkflowName(existing, name) {
    const base = cleanWorkflowName(name);
    const taken = new Set([...existing].map((n) => String(n).toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let n = 2;
    while (taken.has(`${base} (${n})`.toLowerCase())) n += 1;
    return `${base} (${n})`;
}

/** Where a profile's edge keeps its library, or null when only the running edge knows. */
function workflowsDir(profile) {
    // A deck profile always has a data folder; a script profile only when one was chosen, since
    // otherwise its workflows live wherever the script's own IvoryOS keeps them.
    return profile && profile.dataDir ? path.join(profile.dataDir, 'workflows') : null;
}

function namesOnDisk(dir) {
    try {
        return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).map((f) => f.slice(0, -5));
    } catch {
        return [];
    }
}

/**
 * Add workflows ({name, body}) to a profile's library without replacing anything already there:
 * a name in use gets a number. Returns [{requested, saved}] so the caller can say what each was
 * saved as.
 * @param {object} profile
 * @param {{name: string, body: object}[]} workflows
 * @param {{url?: string|null, fetch?: typeof fetch}} [edge]  the running edge, when there is one
 */
async function addWorkflows(profile, workflows, { url = null, fetch: fetchFn = globalThis.fetch } = {}) {
    const results = [];
    if (url) {
        const listed = await fetchFn(`${url}/api/workflows`).then((r) => r.json()).catch(() => null);
        const rows = Array.isArray(listed) ? listed : (listed && listed.workflows) || [];
        const existing = new Set(rows.map((w) => (typeof w === 'string' ? w : w && w.name)).filter(Boolean));
        for (const { name, body } of workflows) {
            const saved = freeWorkflowName(existing, name);
            // `force`: a template may link to workflows this deck does not have; the edge says so
            // on the Library page, which is where the person can act on it.
            const res = await fetchFn(`${url}/api/workflows/${encodeURIComponent(saved)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...body, name: saved, note: 'Added from the IvoryOS Hub', force: true }),
            });
            if (!res.ok) {
                const answer = await res.json().catch(() => ({}));
                throw new LibraryError(`Could not save "${saved}": ${answer.error || `the deck answered ${res.status}`}`);
            }
            existing.add(saved);
            results.push({ requested: name, saved });
        }
        return results;
    }
    const dir = workflowsDir(profile);
    if (!dir) throw new LibraryError('Start this profile first: its workflows are kept wherever its script keeps them.');
    fs.mkdirSync(dir, { recursive: true });
    const existing = new Set(namesOnDisk(dir));
    for (const { name, body } of workflows) {
        const saved = freeWorkflowName(existing, name);
        const file = path.join(dir, `${saved}.json`);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ ...body, name: saved }, null, 4));
        fs.renameSync(tmp, file);
        existing.add(saved);
        results.push({ requested: name, saved });
    }
    return results;
}

module.exports = { LibraryError, cleanWorkflowName, freeWorkflowName, workflowsDir, addWorkflows };
