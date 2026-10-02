'use strict';
// The example lab: a script profile anyone can start on first launch to see IvoryOS work, with
// nothing plugged in. The instruments are the repository's simulated drivers (example/lab_drivers.py,
// shipped with the app), and the script is short on purpose: it is meant to be read and edited in
// the profile's Code tab, then restarted, which is the whole loop of running a lab from a script.
const fs = require('node:fs');
const path = require('node:path');

const DRIVER_FILES = ['lab_drivers.py'];

const SCRIPT = `"""An example lab for IvoryOS: simulated instruments, no hardware needed.

Three syringe pumps charge a vial, a heater-stirrer holds it at temperature, and a UV-Vis
probe and an HPLC read out how much product formed. The drivers share one reaction model
(lab_drivers.py, in this folder), so a workflow built in the Designer really does chemistry,
and an optimization over temperature, catalyst loading and time finds a genuine optimum.

Edit this file in the Code tab and press Restart: every module-level instrument object
below becomes a device in the UI, named after its variable.
"""
import os

from lab_drivers import AnalyticalBalance, HeaterStirrer, HPLC, SyringePump, UVVisSpectrometer

import ivoryos_edge

# --- Reagent delivery --------------------------------------------------------------------
pump_1 = SyringePump(reagent="4-bromoanisole, 0.50 M in dioxane", role="substrate", concentration_m=0.50)
pump_2 = SyringePump(reagent="phenylboronic acid, 0.50 M in dioxane", role="boronic_acid", concentration_m=0.50)
pump_3 = SyringePump(reagent="Pd(dppf)Cl2, 10 mM in dioxane", role="catalyst", concentration_m=0.010)

# --- Reaction and analytics --------------------------------------------------------------
reactor = HeaterStirrer(max_temperature_c=150.0)
balance = AnalyticalBalance()
uv_vis = UVVisSpectrometer(path_length_cm=1.0)
hplc = HPLC()

# Start the edge server. The launcher passes the profile's port as IVORYOS_PORT.
ivoryos_edge.run(__name__, port=int(os.environ.get("IVORYOS_PORT", 8080)))
`;

/** Where the example's driver files come from: the repository in development, the app bundle when packaged. */
function exampleSource({ isPackaged, resourcesPath, repoRoot }) {
    const dir = isPackaged ? path.join(resourcesPath, 'example') : path.join(repoRoot, 'example');
    return DRIVER_FILES.every((f) => fs.existsSync(path.join(dir, f))) ? dir : null;
}

/**
 * Write the example into `<home>/example/` (the script every time, so an edited copy can be
 * reset by removing the profile and trying the example again; the drivers only when missing)
 * and return the fields for its script profile. Pure file work, so it is tested without Electron.
 */
function materializeExample(home, sourceDir) {
    const dir = path.join(home, 'example');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of DRIVER_FILES) {
        const target = path.join(dir, f);
        if (!fs.existsSync(target)) fs.copyFileSync(path.join(sourceDir, f), target);
    }
    const script = path.join(dir, 'example_lab.py');
    fs.writeFileSync(script, SCRIPT);
    return { kind: 'script', name: 'Example lab (simulated)', script, cwd: dir, dataDir: path.join(dir, 'data') };
}

module.exports = { exampleSource, materializeExample, DRIVER_FILES, EXAMPLE_SCRIPT: SCRIPT };
