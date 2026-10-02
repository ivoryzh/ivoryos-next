'use strict';
// The Automation Hub's catalog, read straight from the Hub's database (Supabase's REST API).
//
// The launcher used to ask the Hub website for it (`/api/catalog/*`), which meant the catalog only
// worked where that website was deployed with those routes. The database is reachable directly
// with its public key, and row-level security decides what each request may see: anonymous gets
// public rows, a signed-in request (the person's session, from account.js) also gets their own
// private rows and their organizations' -- the private hub. So nothing here filters visibility.
//
// The one exception is a Hub whose database predates the private hub (no `visibility` column;
// supabase_migrations/20260929_private_hub_and_plugin_api.sql in landing-page-supabase). Its read
// policies are `using (true)`, so it returns everyone's unlisted rows; for that database this
// applies the rule the Hub website applies in each page -- listed rows, plus the caller's own.
//
// The conversions (a driver to a deck entry, a plugin to a deck reference, a template to an edge
// workflow) mirror the Hub's utils/deck-manifest.ts and utils/workflow-format.ts, which its own
// "Open in IvoryOS" button uses. Change them together: two decks built from one module must match.
//
// Pure apart from the injected `fetch`, so it is tested without Electron (test/hubCatalog.test.js).

const DECK_FORMAT = 'ivoryos-deck/1';
const DEVICE_FIELDS = 'devices(name,vendor,category,image_url)';
const OWNER_FIELDS = 'visibility,org_id,contributor_id,organizations(name)';

const MODULE_FIELDS = `id,name,description,icon_emoji,pip_name,module_path,module_name,connection,os,init_args,python_command,is_tested_with_ivoryos,updated_at,${DEVICE_FIELDS}`;
const SUMMARY_FIELDS = `id,name,description,icon_emoji,pip_name,connection,is_tested_with_ivoryos,updated_at,${DEVICE_FIELDS}`;
const PLATFORM_FIELDS = 'id,name,description,image_url,demo_url,modules,updated_at';
const PLUGIN_FIELDS = 'id,name,description,pip_name,import_path,module_name,is_agnostic,module_ids,platform_ids,screenshot_urls,updated_at';
const TEMPLATE_FIELDS = 'id,title,description,module_ids,platform_id,updated_at,workflow_json';

class HubError extends Error {}

// --- conversions (mirror landing-page-supabase utils/deck-manifest.ts) ----------------------------

/** A pip requirement for a Hub package field: a bare repository URL gets the `git+` it needs. */
function requirementFor(pkg) {
    const target = String(pkg || '').trim();
    if (!target) return '';
    if (/^(git|hg|bzr|svn)\+/i.test(target)) return target;
    if (/\.(whl|tar\.gz|tgz|zip)(#.*)?$/i.test(target)) return target;
    if (/^(https?|ssh):\/\//i.test(target) || target.startsWith('git@')) return `git+${target}`;
    return target;
}

/** One form value as the deck argument it stands for; undefined means "leave it out". */
function argValue(def, value) {
    if (def.type === 'object') {
        const inner = value && typeof value === 'object' ? value : {};
        const args = {};
        for (const nested of def.args || []) {
            const v = argValue(nested, inner[nested.name]);
            if (v !== undefined) args[nested.name] = v;
        }
        if (!def.import_path || !def.class_name) return args;
        return { $object: { import: def.import_path, class: def.class_name, args } };
    }
    if (value === undefined || value === null || value === '') return undefined;
    switch (def.type) {
        case 'int': { const n = Number.parseInt(String(value), 10); return Number.isFinite(n) ? n : String(value); }
        case 'float': { const n = Number.parseFloat(String(value)); return Number.isFinite(n) ? n : String(value); }
        case 'bool': return value === true || value === 'true' || value === 'True';
        default: return String(value);
    }
}

/** `python_command` (`connect()`, `device.Connect(address="...")`) as deck `calls`. */
function parsePythonCommand(command) {
    const text = String(command || '').trim();
    if (!text) return { calls: [] };
    const match = /^(?:device)?\.?([A-Za-z_]\w*)\(([\s\S]*)\)$/.exec(text);
    if (!match) return { calls: [], warning: `Setup command not converted, run it yourself: ${text}` };
    const [, method, argText] = match;
    const args = {};
    const body = argText.trim();
    if (body) {
        const argRe = /\s*([A-Za-z_]\w*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d+(?:\.\d+)?|True|False|None)\s*(?:,|$)/y;
        let consumed = 0;
        let m;
        while ((m = argRe.exec(body)) !== null) {
            const raw = m[2];
            args[m[1]] = raw === 'True' ? true : raw === 'False' ? false : raw === 'None' ? null
                : /^["']/.test(raw) ? raw.slice(1, -1) : Number(raw);
            consumed = argRe.lastIndex;
        }
        if (consumed !== body.length) return { calls: [], warning: `Setup command not converted, run it yourself: ${text}` };
    }
    return { calls: [{ method, ...(Object.keys(args).length ? { args } : {}) }] };
}

/** One Hub module plus the person's settings, as a deck instrument and its package. */
function moduleToDeckEntry(module, name, connection = {}) {
    const warnings = [];
    const args = {};
    if (connection.type === 'usb') {
        if (connection.port) args.port = String(connection.port);
    } else if (connection.type) {
        if (connection.ip) args.ip = String(connection.ip);
        if (connection.networkPort !== undefined && connection.networkPort !== '') {
            const n = Number(connection.networkPort);
            args.port = Number.isFinite(n) ? n : String(connection.networkPort);
        }
    }
    for (const def of module.init_args || []) {
        const v = argValue(def, connection.args && connection.args[def.name]);
        if (v !== undefined) args[def.name] = v;
    }
    const { calls, warning } = parsePythonCommand(module.python_command);
    if (warning) warnings.push(warning);
    const requirement = requirementFor(module.pip_name);
    return {
        instrument: {
            name,
            import: module.module_path || module.pip_name || '',
            class: module.module_name,
            ...(Object.keys(args).length ? { args } : {}),
            ...(calls && calls.length ? { calls } : {}),
            hub: { moduleId: module.id, name: module.name, init_args: module.init_args || [], connection: module.connection || [] },
        },
        packages: requirement ? [requirement] : [],
        warnings,
    };
}

/**
 * A plugin's deck entry, or why it has none. Only v2 (an ivoryos_edge Plugin) can be on a deck; a
 * v1 plugin is a Flask blueprint this IvoryOS cannot run. A database without `plugin_api` predates
 * v2 on the Hub, so everything in it is v1.
 */
function pluginToDeckEntry(plugin) {
    const name = String(plugin.name || '').trim();
    if ((plugin.plugin_api || 'v1') !== 'v2') {
        return {
            packages: [], plugins: [],
            blocked: `${name} is a v1 plugin, a Flask blueprint for the original IvoryOS. This IvoryOS runs only v2 plugins. `
                + 'Its author can port it; the IvoryOS plugin guide covers moving a Flask blueprint plugin over.',
        };
    }
    const importPath = String(plugin.import_path || '').trim();
    const attribute = String(plugin.module_name || 'plugin').trim();
    if (!/^[A-Za-z_][\w.]*$/.test(importPath) || !/^[A-Za-z_]\w*$/.test(attribute)) {
        return { packages: [], plugins: [], blocked: `${name} does not say which module and attribute hold its plugin.` };
    }
    const requirement = requirementFor(plugin.pip_name);
    return { packages: requirement ? [requirement] : [], plugins: [`${importPath}:${attribute}`], blocked: null };
}

// --- templates (mirror landing-page-supabase utils/workflow-format.ts) ----------------------------

const FLOW_CONTROL = 'Flow_Control';
const isFlowControl = (instrument) => instrument === 'Flow Control' || instrument === FLOW_CONTROL;

function uuidOf(b) {
    return Number.isFinite(Number(b && b.uuid)) ? Number(b.uuid) : Math.floor(Math.random() * 1e9);
}

/** The original IvoryOS's `wait` / `pause` pseudo-instruments, as Core's Flow Control steps. */
function builtInStep(b) {
    const instrument = String((b && b.instrument) || '');
    const statement = b && b.args ? b.args.statement : undefined;
    if (instrument === 'wait') {
        const seconds = Number(statement);
        return { instrument: FLOW_CONTROL, action: 'Sleep', args: { duration_seconds: Number.isFinite(seconds) ? seconds : statement }, arg_types: { duration_seconds: 'float' } };
    }
    if (instrument === 'pause') {
        // A User input with no name to save under only pauses: the message, then Continue.
        return {
            instrument: FLOW_CONTROL, action: 'User_Input',
            args: { prompt: String(statement ?? 'Continue?') },
            arg_types: { prompt: 'str' },
        };
    }
    return null;
}

function toEdgeBlocks(blocks) {
    return (Array.isArray(blocks) ? blocks : []).map((b, i) => {
        const builtIn = builtInStep(b);
        if (builtIn) return { id: i + 1, uuid: uuidOf(b), ...builtIn, return: '', batch_action: !!(b && b.batch_action) };
        const instrument = String((b && b.instrument) || '');
        return {
            id: i + 1,
            uuid: uuidOf(b),
            instrument: isFlowControl(instrument) ? FLOW_CONTROL : instrument.startsWith('deck.') ? instrument.slice(5) : instrument,
            action: String((b && (b.action ?? b.method)) ?? ''),
            args: b && b.args && typeof b.args === 'object' ? b.args : (b && b.params && typeof b.params === 'object' ? b.params : {}),
            arg_types: b && b.arg_types && typeof b.arg_types === 'object' ? b.arg_types : {},
            return: String((b && (b.return ?? b.returnVar)) ?? ''),
            batch_action: !!(b && (b.batch_action ?? b.isBatchAction)),
        };
    });
}

/** A template's stored workflow (legacy `script_dict`, or the edge's own shape) as the edge saves it. */
function toEdgeWorkflow(json, fallbackName) {
    const phases = (json && (json.script_dict || json)) || {};
    return {
        name: String((json && json.name) || fallbackName || 'Hub template'),
        description: String((json && json.description) || ''),
        prep: toEdgeBlocks(phases.prep),
        script: toEdgeBlocks(phases.script ?? phases.sequence),
        cleanup: toEdgeBlocks(phases.cleanup),
    };
}

function instrumentsUsed(workflow) {
    const seen = [];
    for (const block of [...workflow.prep, ...workflow.script, ...workflow.cleanup]) {
        if (block.instrument && !isFlowControl(block.instrument) && !seen.includes(block.instrument)) seen.push(block.instrument);
    }
    return seen;
}

const ids = (values) => (Array.isArray(values) ? values.map(Number).filter(Number.isFinite) : []);

function templateSummary(t) {
    const { workflow_json: body, ...rest } = t;
    const workflow = toEdgeWorkflow(body, t.title || `template_${t.id}`);
    return {
        ...rest,
        module_ids: ids(t.module_ids),
        workflowName: workflow.name,
        instruments: instrumentsUsed(workflow),
        steps: { prep: workflow.prep.length, script: workflow.script.length, cleanup: workflow.cleanup.length },
    };
}

// --- the database -------------------------------------------------------------------------------

class HubCatalog {
    /**
     * @param {object} opts
     * @param {typeof fetch} opts.fetch
     * @param {string} opts.url     the Hub's Supabase project URL
     * @param {string} opts.key     its public (anon) key
     * @param {() => Promise<string|null>} opts.token   the signed-in session's access token, or null
     * @param {() => string|null} opts.userId           the signed-in user's id, or null
     */
    constructor({ fetch, url, key, token = async () => null, userId = () => null }) {
        this.fetch = fetch;
        this.url = url.replace(/\/+$/, '');
        this.key = key;
        this.token = token;
        this.userId = userId;
        this.legacy = null; // true: the database has no `visibility` yet (learned on first read)
    }

    async _get(table, query) {
        const token = await this.token().catch(() => null);
        let res;
        try {
            res = await this.fetch(`${this.url}/rest/v1/${table}?${query}`, {
                headers: { apikey: this.key, Authorization: `Bearer ${token || this.key}`, Accept: 'application/json' },
            });
        } catch (e) {
            throw new HubError(`Could not reach the Automation Hub (${e.message}).`);
        }
        const text = await res.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        if (!res.ok) {
            throw Object.assign(new HubError((body && (body.message || body.error)) || `The Automation Hub answered ${res.status}.`), { code: body && body.code });
        }
        return body || [];
    }

    /**
     * A message for the IvoryOS team through the Hub's contact inquiries (the table its website's
     * contact form writes): {name, email, message}. Used for "Cloud early access" while Cloud is
     * not offered. Insert only; nothing is read back.
     */
    async contactInquiry({ name, email, message }) {
        const token = await this.token().catch(() => null);
        let res;
        try {
            res = await this.fetch(`${this.url}/rest/v1/contact_inquiries`, {
                method: 'POST',
                headers: {
                    apikey: this.key, Authorization: `Bearer ${token || this.key}`,
                    'Content-Type': 'application/json', Prefer: 'return=minimal',
                },
                body: JSON.stringify({ name, email, message }),
            });
        } catch (e) {
            throw new HubError(`Could not reach IvoryOS (${e.message}).`);
        }
        if (res.ok) return true;
        const text = await res.text().catch(() => '');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        throw new HubError((body && (body.message || body.error)) || `IvoryOS answered ${res.status}.`);
    }

    /**
     * File a problem report (problemReport.js) in `problem_reports`. Clients may only insert there:
     * no read policy, so the id is made here and is the reference the person is given. A signed-in
     * request is tied to its account by the table's own default (auth.uid()), never by a field sent.
     */
    async fileReport(row) {
        const token = await this.token().catch(() => null);
        let res;
        try {
            res = await this.fetch(`${this.url}/rest/v1/problem_reports`, {
                method: 'POST',
                headers: {
                    apikey: this.key, Authorization: `Bearer ${token || this.key}`,
                    'Content-Type': 'application/json', Prefer: 'return=minimal',
                },
                body: JSON.stringify(row),
            });
        } catch (e) {
            throw new HubError(`Could not reach IvoryOS (${e.message}).`);
        }
        if (res.ok) return { id: row.id };
        const text = await res.text().catch(() => '');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
        // PGRST205 / 42P01: a Hub database without the problem_reports migration.
        const missing = res.status === 404 || (body && ['PGRST205', '42P01'].includes(body.code));
        throw Object.assign(new HubError(missing
            ? 'IvoryOS cannot take reports here yet.'
            : (body && (body.message || body.error)) || `IvoryOS answered ${res.status}.`), { code: missing ? 'unavailable' : body && body.code });
    }

    /**
     * Rows of a catalog table. `owned`: the table has `visibility` (with the migration) or
     * `is_unlisted` (without it), so it needs the legacy rule on an old database.
     */
    async _rows(table, fields, filters = [], { unlisted = false } = {}) {
        const withOwner = () => this._get(table, [`select=${fields},${OWNER_FIELDS}`, ...filters].join('&'));
        if (this.legacy !== true) {
            try {
                const rows = await withOwner();
                this.legacy = false;
                return rows;
            } catch (e) {
                // 42703: undefined column; PGRST200/204: an unknown relationship (organizations).
                if (!['42703', 'PGRST200', 'PGRST204', 'PGRST100'].includes(e.code) && !/visibility|org_id|organizations/.test(e.message)) throw e;
                this.legacy = true;
            }
        }
        const uid = this.userId();
        const legacyFilters = unlisted
            ? [`or=(is_unlisted.is.null,is_unlisted.eq.false${uid ? `,contributor_id.eq.${uid}` : ''})`]
            : [];
        // `plugin_api` came with the same migration as `visibility`.
        const legacyFields = fields.replace(/,plugin_api\b/, '');
        const rows = await this._get(table, [`select=${legacyFields},contributor_id${unlisted ? ',is_unlisted' : ''}`, ...filters, ...legacyFilters].join('&'));
        return rows.map((r) => ({ ...r, visibility: r.is_unlisted ? 'private' : 'public', org_id: null, organizations: null }));
    }

    async browse() {
        return { modules: await this._rows('modules', SUMMARY_FIELDS, ['order=is_tested_with_ivoryos.desc,name.asc', 'limit=2000'], { unlisted: true }) };
    }

    async search(q, limit = 60) {
        const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
            .map((w) => w.replace(/[,()*%\\.:"]/g, '')).filter(Boolean);
        const filters = ['order=is_tested_with_ivoryos.desc,name.asc', `limit=${Math.min(Math.max(Number(limit) || 60, 1), 200)}`];
        if (words.length) {
            const clauses = words.map((w) => `or(name.ilike.*${w}*,description.ilike.*${w}*,pip_name.ilike.*${w}*,module_name.ilike.*${w}*)`);
            filters.push(`and=(${clauses.join(',')})`);
        }
        return { modules: await this._rows('modules', MODULE_FIELDS, filters, { unlisted: true }) };
    }

    async module(id) {
        const [row] = await this._rows('modules', MODULE_FIELDS, [`id=eq.${Number(id)}`], { unlisted: true });
        if (!row) throw new HubError('That driver is not on the Automation Hub, or is not shared with you.');
        return { module: row };
    }

    async deckEntry({ moduleId, name, connection }) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(name || ''))) {
            throw new HubError('Instrument names use letters, digits and underscores, starting with a letter.');
        }
        const { module } = await this.module(moduleId);
        return moduleToDeckEntry(module, String(name), connection || {});
    }

    async platforms() {
        return { platforms: await this._rows('platforms', PLATFORM_FIELDS, ['order=name.asc']) };
    }

    async platform(id) {
        const [platform] = await this._rows('platforms', PLATFORM_FIELDS, [`id=eq.${Number(id)}`]);
        if (!platform) throw new HubError('That platform is not on the Automation Hub, or is not shared with you.');
        const moduleIds = ids(platform.modules);
        const [modules, plugins, templates] = await Promise.all([
            moduleIds.length ? this._rows('modules', MODULE_FIELDS, [`id=in.(${moduleIds.join(',')})`], { unlisted: true }) : [],
            this._rows('plugins', PLUGIN_FIELDS_WITH_API(this), [`platform_ids=cs.{${Number(platform.id)}}`]),
            this._rows('templates', TEMPLATE_FIELDS, [`platform_id=eq.${Number(platform.id)}`], { unlisted: true }),
        ]);
        const found = new Map(modules.map((m) => [Number(m.id), m]));
        return {
            platform: {
                ...platform,
                // In the platform's own order; one the caller may not see is reported, not dropped.
                modules: moduleIds.filter((m) => found.has(m)).map((m) => found.get(m)),
                hiddenModules: moduleIds.filter((m) => !found.has(m)),
                plugins: plugins.map((p) => ({ ...p, entry: pluginToDeckEntry(p) })),
                templates: templates.map(templateSummary),
            },
        };
    }

    async plugins() {
        const rows = await this._rows('plugins', PLUGIN_FIELDS_WITH_API(this), ['order=name.asc']);
        return { plugins: rows.map((p) => ({ ...p, entry: pluginToDeckEntry(p) })) };
    }

    async plugin(id) {
        const [row] = await this._rows('plugins', PLUGIN_FIELDS_WITH_API(this), [`id=eq.${Number(id)}`]);
        if (!row) throw new HubError('That plugin is not on the Automation Hub, or is not shared with you.');
        return { plugin: { ...row, entry: pluginToDeckEntry(row) } };
    }

    async templates() {
        const rows = await this._rows('templates', TEMPLATE_FIELDS, ['order=updated_at.desc.nullslast'], { unlisted: true });
        return { templates: rows.map(templateSummary) };
    }

    async template(id) {
        const [row] = await this._rows('templates', TEMPLATE_FIELDS, [`id=eq.${Number(id)}`], { unlisted: true });
        if (!row) throw new HubError('That template is not on the Automation Hub, or is not shared with you.');
        return { template: { ...templateSummary(row), workflow: toEdgeWorkflow(row.workflow_json, row.title || `template_${row.id}`) } };
    }
}

// `plugin_api` arrives with the private-hub migration; an older database has no such column.
function PLUGIN_FIELDS_WITH_API(catalog) {
    return catalog.legacy === true ? PLUGIN_FIELDS : `${PLUGIN_FIELDS},plugin_api`;
}

module.exports = {
    HubCatalog, HubError, DECK_FORMAT,
    requirementFor, argValue, parsePythonCommand, moduleToDeckEntry, pluginToDeckEntry, toEdgeWorkflow, instrumentsUsed, templateSummary,
};
