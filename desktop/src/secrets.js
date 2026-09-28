'use strict';
// Small JSON values that must not sit on disk in the clear: the account session and the tokens
// for private GitHub/GitLab repositories.
//
// Encrypted with Electron's safeStorage (the OS keychain on macOS, DPAPI on Windows, the secret
// service on Linux). Where no keychain is available (a bare Linux session) nothing is written:
// the value lives in memory and the person signs in again next launch, which is better than a
// token in a plain file they do not know about.

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} file
 * @param {{isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string}} safeStorage
 * @returns {{read(): any, write(value: any): void, persistent: boolean}}
 */
function secretFile(file, safeStorage) {
    let memory = null;
    const available = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
    return {
        get persistent() { return available(); },
        read() {
            if (!available()) return memory;
            try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); } catch { return null; }
        },
        write(value) {
            memory = value;
            if (!available()) return;
            if (value === null || value === undefined) {
                fs.rmSync(file, { force: true });
                return;
            }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp`;
            fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600 });
            fs.renameSync(tmp, file);
        },
    };
}

module.exports = { secretFile };
