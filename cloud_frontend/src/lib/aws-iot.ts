import {
    IoTClient,
    CreateThingCommand,
    CreateKeysAndCertificateCommand,
    AttachPolicyCommand,
    AttachThingPrincipalCommand,
    DeleteThingCommand,
    UpdateCertificateCommand,
    DeleteCertificateCommand,
} from "@aws-sdk/client-iot";

// Downloaded and verified directly from https://www.amazontrust.com/repository/AmazonRootCA1.pem
// (SHA256 fingerprint 8E:CD:E6:88:4F:3D:87:B1:12:5B:A3:1A:C3:FC:B1:3D:70:16:DE:7F:57:CC:90:4F:E1:CB:97:C6:AE:98:19:6E)
// rather than hand-transcribed — a single wrong character here would silently break every
// device's TLS handshake in a way that's miserable to debug. This is public and the same for
// every AWS IoT customer; it is not a secret.
const AMAZON_ROOT_CA1 = `-----BEGIN CERTIFICATE-----
MIIDQTCCAimgAwIBAgITBmyfz5m/jAo54vB4ikPmljZbyjANBgkqhkiG9w0BAQsF
ADA5MQswCQYDVQQGEwJVUzEPMA0GA1UEChMGQW1hem9uMRkwFwYDVQQDExBBbWF6
b24gUm9vdCBDQSAxMB4XDTE1MDUyNjAwMDAwMFoXDTM4MDExNzAwMDAwMFowOTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoTBkFtYXpvbjEZMBcGA1UEAxMQQW1hem9uIFJv
b3QgQ0EgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALJ4gHHKeNXj
ca9HgFB0fW7Y14h29Jlo91ghYPl0hAEvrAIthtOgQ3pOsqTQNroBvo3bSMgHFzZM
9O6II8c+6zf1tRn4SWiw3te5djgdYZ6k/oI2peVKVuRF4fn9tBb6dNqcmzU5L/qw
IFAGbHrQgLKm+a/sRxmPUDgH3KKHOVj4utWp+UhnMJbulHheb4mjUcAwhmahRWa6
VOujw5H5SNz/0egwLX0tdHA114gk957EWW67c4cX8jJGKLhD+rcdqsq08p8kDi1L
93FcXmn/6pUCyziKrlA4b9v7LWIbxcceVOF34GfID5yHI9Y/QCB/IIDEgEw+OyQm
jgSubJrIqg0CAwEAAaNCMEAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC
AYYwHQYDVR0OBBYEFIQYzIU07LwMlJQuCFmcx7IQTgoIMA0GCSqGSIb3DQEBCwUA
A4IBAQCY8jdaQZChGsV2USggNiMOruYou6r4lK5IpDB/G/wkjUu0yKGX9rbxenDI
U5PMCCjjmCXPI6T53iHTfIUJrU6adTrCC2qJeHZERxhlbI1Bjjt/msv0tadQ1wUs
N+gDS63pYaACbvXy8MWy7Vu33PqUXHeeE6V/Uq2V8viTO96LXFvKWlJbYK8U90vv
o/ufQJVtMVT8QtPHRh8jrdkPSHCa2XV4cdFyQzR1bldZwgJcJmApzyMZFo6IQ6XU
5MsI+yMRQ+hDKXJioaldXgjUkK642M4UwtBV8ob2xJNDd2ZhwLnoQdeXeGADbkpy
rqXRfboQnoZsG4q5WTP468SQvvG5
-----END CERTIFICATE-----`;

let _iot: IoTClient | null = null;
function getIotClient(): IoTClient {
    if (!_iot) {
        _iot = new IoTClient({ region: process.env.AWS_REGION || "us-east-1" });
    }
    return _iot;
}

// AWS Thing names allow letters, numbers, and - _ : only, up to 128 chars. A device-chosen label
// can contain anything, so derive a safe name from it rather than rejecting most real-world input.
export function sanitizeThingName(label: string): string {
    const cleaned = (label || "").replace(/[^a-zA-Z0-9_:-]/g, "-").slice(0, 100);
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${cleaned || "edge-device"}-${suffix}`;
}

export interface ProvisionResult {
    thingName: string;
    token: string; // base64 CLOUD_TOKEN, ready to paste into the edge server's Cloud Connect page
}

/**
 * Creates a brand-new AWS IoT Thing + certificate for one device, attaches the shared
 * ThingName-scoped policy (see supabase/migrations or AGENTS.md for the policy JSON — created
 * once, by hand, in the AWS console; this function only ever attaches it, never creates it), and
 * packages the result into the CLOUD_TOKEN format edge_server's setup_broker() expects.
 *
 * This is the one function that should ever mint device credentials — every device gets its own
 * Thing/cert so a compromised or revoked device can't affect any other tenant, and the attached
 * policy's ${iot:Connection.Thing.ThingName} variable is what actually enforces that isolation at
 * the broker level (see AGENTS.md's Cloud section for the full explanation).
 */
export async function provisionDevice(label: string): Promise<ProvisionResult> {
    const endpoint = process.env.AWS_IOT_ENDPOINT;
    const policyName = process.env.AWS_IOT_POLICY_NAME;
    if (!endpoint || !policyName) {
        throw new Error("AWS_IOT_ENDPOINT and AWS_IOT_POLICY_NAME must be set — see .env.local.example.");
    }

    const iot = getIotClient();
    const thingName = sanitizeThingName(label);
    let certificateArn: string | undefined;

    try {
        await iot.send(new CreateThingCommand({ thingName }));

        const cert = await iot.send(new CreateKeysAndCertificateCommand({ setAsActive: true }));
        certificateArn = cert.certificateArn;
        const certificatePem = cert.certificatePem;
        const privateKey = cert.keyPair?.PrivateKey;
        if (!certificateArn || !certificatePem || !privateKey) {
            throw new Error("AWS IoT did not return a complete certificate/key pair.");
        }

        await iot.send(new AttachPolicyCommand({ policyName, target: certificateArn }));
        await iot.send(new AttachThingPrincipalCommand({ thingName, principal: certificateArn }));

        const tokenPayload = {
            protocol: "aws_iot",
            endpoint,
            client_id: thingName,
            topic_prefix: "ivoryos/edge",
            certs: {
                root_ca: AMAZON_ROOT_CA1,
                cert_pem: certificatePem,
                private_key: privateKey,
            },
        };
        const token = Buffer.from(JSON.stringify(tokenPayload)).toString("base64");
        return { thingName, token };
    } catch (err) {
        // Best-effort cleanup so a failed provision doesn't leave an orphaned Thing/cert behind in
        // the AWS account — not a full compensating transaction (AttachPolicy/AttachThingPrincipal
        // failures after the cert was created are the case this actually guards), but better than
        // silently accumulating debris on every retry.
        if (certificateArn) {
            try {
                const certificateId = certificateArn.split("/").pop()!;
                await iot.send(new UpdateCertificateCommand({ certificateId, newStatus: "INACTIVE" }));
                await iot.send(new DeleteCertificateCommand({ certificateId }));
            } catch { /* best-effort; the original error below is what matters */ }
        }
        try {
            await iot.send(new DeleteThingCommand({ thingName }));
        } catch { /* best-effort */ }
        throw err;
    }
}
