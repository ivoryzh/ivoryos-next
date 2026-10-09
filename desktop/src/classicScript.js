'use strict';
// Scripts written for IvoryOS Classic (`import ivoryos`), which stop at that import here: the app
// runs IvoryOS NextGen (`ivoryos_edge`). Spotted here from the text, so starting any other script
// costs nothing; converting is the edge's own ivoryos_edge/classic.py, which reads the script with
// Python's parser rather than guessing at it in JavaScript (main.js `launcher:classic-script`).
//
// Pure, so it is tested without Electron (test/classicScript.test.js).

// `import ivoryos`, `import ivoryos as x`, `import ivoryos.x`, `from ivoryos import ...`,
// `from ivoryos.config import ...`, at the start of a line (so not in a comment), and never
// `ivoryos_edge` or another package whose name starts the same way.
const CLASSIC_IMPORT = /^[ \t]*(?:import[ \t]+ivoryos(?![\w])|from[ \t]+ivoryos(?:\.[\w.]+)?[ \t]+import\b)/m;

function looksClassic(text) {
    return CLASSIC_IMPORT.test(String(text || ''));
}

module.exports = { looksClassic };
