import { NextResponse } from 'next/server';
import { provisionDevice } from '@/lib/aws-iot';
import { supabaseAdmin } from '@/lib/supabase';

// Automates what was previously a manual "go create a Thing in the AWS console" step — see
// AGENTS.md's Cloud section. Creates the AWS IoT identity for a new device and hands back a
// ready-to-paste CLOUD_TOKEN; the device doesn't exist as far as Cloud/Supabase is concerned
// until it actually connects and daemon.js writes its first status/schema message (this row is
// just a placeholder so it shows up in the device list immediately, named, before that happens).
export async function POST(req: Request) {
    try {
        const body = await req.json().catch(() => ({}));
        const label = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'edge-device';

        const { thingName, token } = await provisionDevice(label);

        const { error } = await supabaseAdmin.from('devices').upsert({
            id: thingName,
            name: label,
            status: 'offline',
        }, { onConflict: 'id' });
        if (error) {
            console.error('Provisioned AWS IoT Thing but failed to create its Supabase row:', error.message);
            // Not fatal — the device will still appear once it connects and the daemon upserts it.
        }

        return NextResponse.json({ deviceId: thingName, token });
    } catch (err: any) {
        return NextResponse.json({ error: err.message || 'Failed to provision device.' }, { status: 500 });
    }
}
