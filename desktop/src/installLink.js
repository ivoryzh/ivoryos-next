'use strict';
// What an `ivoryos://install` link from the Automation Hub asks for: Hub ids, never install
// instructions. The Hub website's "Open in IvoryOS" button sends
//
//     ivoryos://install?modules=4,7,7&plugins=3&templates=9&optimizers=ax-platform
//     ivoryos://install?platform=12
//
// and the app reads every driver, plugin and workflow from the Hub itself (hubCatalog.js), then
// opens its own install screen on them. So a link can only ever point at what is on the Hub, and
// anyone reading one can see what it asks for.
//
// The old form, a whole deck encoded in the link (`?deck=`), is refused: any web page could build
// one naming any package or any importable class, and the app would show it as coming from the Hub.
//
// Pure, so it is tested without Electron (test/installLink.test.js).

const { OPTIMIZERS } = require('./optimizers');

/** At most this many ids of one kind: a Hub build is a bench, not the catalog. */
const MAX_IDS = 50;

class InstallLinkError extends Error {}

function idList(raw, what, { repeats = false } = {}) {
    if (raw === null || raw.trim() === '') return [];
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.every((s) => /^[1-9]\d{0,9}$/.test(s))) {
        throw new InstallLinkError(`The link's ${what} are not Hub ids.`);
    }
    const values = parts.map(Number);
    const list = repeats ? values : [...new Set(values)];
    if (list.length > MAX_IDS) throw new InstallLinkError(`The link asks for more than ${MAX_IDS} ${what}.`);
    return list;
}

/**
 * The request in an `ivoryos://install` URL, or null when it carries no Hub ids (a `?manifest=`
 * link, handled elsewhere). Throws InstallLinkError for a malformed or retired link.
 *
 * `modules` keeps repeats and order (two of the same pump are two instruments); `plugins` and
 * `templates` do not. `optimizers` are ids from optimizers.js, also accepted by package name.
 */
function parseInstallLink(url) {
    const q = url.searchParams;
    if (q.has('deck')) {
        throw new InstallLinkError('This link carries its own install instructions, which IvoryOS no longer accepts from a link. '
            + 'Open it again from the Automation Hub, which now sends Hub ids instead.');
    }
    const kinds = ['platform', 'modules', 'plugins', 'templates', 'optimizers'];
    if (!kinds.some((k) => q.has(k))) return null;

    const platformIds = idList(q.get('platform'), 'platform');
    if (platformIds.length > 1) throw new InstallLinkError('A link opens one platform at a time.');
    const optimizers = [];
    for (const raw of (q.get('optimizers') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        const opt = OPTIMIZERS.find((o) => o.id === raw || o.package === raw);
        if (!opt) throw new InstallLinkError(`'${raw}' is not an optimizer IvoryOS offers.`);
        if (!optimizers.includes(opt.id)) optimizers.push(opt.id);
    }
    const request = {
        platform: platformIds[0] || null,
        modules: idList(q.get('modules'), 'drivers', { repeats: true }),
        plugins: idList(q.get('plugins'), 'plugins'),
        templates: idList(q.get('templates'), 'workflows'),
        optimizers,
    };
    if (request.platform && (request.modules.length || request.plugins.length || request.templates.length)) {
        throw new InstallLinkError('A link names either a platform or its own drivers, plugins and workflows, not both.');
    }
    if (!request.platform && !request.modules.length && !request.plugins.length && !request.templates.length) {
        throw new InstallLinkError('The link does not say what to install.');
    }
    return request;
}

module.exports = { parseInstallLink, InstallLinkError, MAX_IDS };
