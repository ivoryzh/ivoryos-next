'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { looksClassic } = require('../src/classicScript');

test('a Classic import is spotted wherever the script makes it', () => {
    for (const text of [
        'import ivoryos\n', 'import ivoryos as io\n', 'import ivoryos, time\n', 'import ivoryos.config\n',
        'from ivoryos import block\n', 'from ivoryos.config import DemoConfig\n',
        'if __name__ == "__main__":\n    import ivoryos\n    ivoryos.run(__name__)\n',
    ]) assert.equal(looksClassic(text), true, text);
});

test('NextGen, a converted script, comments and look-alikes are not Classic', () => {
    for (const text of [
        'import ivoryos_edge\n', 'import ivoryos_edge as ivoryos\n', 'from ivoryos_edge import run\n',
        '# import ivoryos  # IvoryOS Classic\nimport ivoryos_edge as ivoryos  # IvoryOS NextGen\n',
        'import ivoryos_tools\n', 'x = "import ivoryos"\n', '',
    ]) assert.equal(looksClassic(text), false, text);
});
