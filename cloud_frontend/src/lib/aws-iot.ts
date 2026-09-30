import { aws, issueCertificate, removeThing } from "@/lib/awsThings";

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

export interface ProvisionResult {
    thingName: string;
    token: string; // base64 CLOUD_TOKEN: what the edge's setup_broker reads
    reattached: boolean; // the Thing existed (the same device paired again): its old certificates were revoked
}

/**
 * Credentials for the device whose lasting id is `thingName` (the edge's CLOUD_DEVICE_ID): its
 * Thing, made if new, a fresh certificate with the shared ThingName-scoped policy attached (see
 * AGENTS.md's Cloud section for the policy JSON; created once, by hand, in the AWS console), and
 * every earlier certificate revoked (awsThings.js). Packaged as the CLOUD_TOKEN edge_server's
 * setup_broker() expects.
 *
 * The only place device credentials are minted. Every device has its own Thing/cert, so a
 * compromised or removed device can't affect any other tenant, and the policy's
 * ${iot:Connection.Thing.ThingName} variable is what enforces that isolation at the broker.
 */
export async function provisionDevice(thingName: string): Promise<ProvisionResult> {
    const endpoint = process.env.AWS_IOT_ENDPOINT;
    const policyName = process.env.AWS_IOT_POLICY_NAME;
    if (!endpoint || !policyName) {
        throw new Error("AWS_IOT_ENDPOINT and AWS_IOT_POLICY_NAME must be set — see .env.local.example.");
    }
    const { certificatePem, privateKey, reattached } = await issueCertificate(aws(), thingName, policyName);
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
    return { thingName, token, reattached };
}

/** Revoke a device's certificates and delete its Thing (the Devices page's Remove). */
export async function removeDeviceThing(thingName: string) {
    return removeThing(aws(), thingName);
}
