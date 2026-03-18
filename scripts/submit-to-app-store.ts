import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ── Config from environment ──────────────────────────────────────────
const KEY_ID = process.env.APP_STORE_CONNECT_KEY_ID!;
const ISSUER_ID = process.env.APP_STORE_CONNECT_ISSUER_ID!;
const API_KEY_PATH = process.env.APP_STORE_CONNECT_API_KEY_PATH!;
const APP_BUNDLE_ID = "com.boltapi.autodarts-tools";

const API_BASE = "https://api.appstoreconnect.apple.com/v1";

// Get version from package.json
const packageJsonPath = path.join(__dirname, "..", "package.json");
const version = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")).version;

// ── JWT Token Generation ─────────────────────────────────────────────
function generateJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: KEY_ID, typ: "JWT" };
  const payload = { iss: ISSUER_ID, iat: now, exp: now + 1200, aud: "appstoreconnect-v1" };

  const encode = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");

  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const privateKey = fs.readFileSync(API_KEY_PATH, "utf-8");
  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  const derSignature = sign.sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  const signature = derSignature.toString("base64url");

  return `${signingInput}.${signature}`;
}

let token = generateJWT();

// ── API Helpers ──────────────────────────────────────────────────────
async function api(endpoint: string, options: RequestInit = {}): Promise<any> {
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  const body = await res.text();
  if (!res.ok) {
    console.error(`API Error ${res.status} ${res.statusText}: ${body}`);
    throw new Error(`API request failed: ${res.status} ${res.statusText}`);
  }
  return body ? JSON.parse(body) : null;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Submit a single platform ─────────────────────────────────────────
async function submitPlatform(appId: string, platform: "IOS" | "MAC_OS") {
  const platformLabel = platform === "IOS" ? "iOS" : "macOS";
  console.log(`\n── ${platformLabel} ──────────────────────────────────────`);

  // 1. Wait for build to be processed
  console.log(`⏳ Waiting for ${platformLabel} build...`);
  let build: any = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const buildsRes = await api(
      `/builds?filter[app]=${appId}&filter[version]=${version}&filter[processingState]=VALID&sort=-uploadedDate&limit=5`,
    );
    for (const b of buildsRes.data) {
      if (b.attributes?.processingState === "VALID") {
        build = b;
        break;
      }
    }
    if (build) break;
    console.log(`   Build not ready yet, retrying in 30s... (attempt ${attempt + 1}/60)`);
    await sleep(30_000);
    if (attempt % 20 === 19) token = generateJWT();
  }
  if (!build) {
    console.log(`⚠️  ${platformLabel} build not found, skipping.`);
    return;
  }
  console.log(`   Build ready: ${build.attributes.version} (${build.id})`);

  // 2. Create or find App Store version for this platform
  console.log(`📦 Creating ${platformLabel} App Store version...`);
  let appStoreVersion: any;
  try {
    const createVersionRes = await api("/appStoreVersions", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "appStoreVersions",
          attributes: {
            platform,
            versionString: version,
            releaseType: "AFTER_APPROVAL",
          },
          relationships: {
            app: { data: { type: "apps", id: appId } },
          },
        },
      }),
    });
    appStoreVersion = createVersionRes.data;
    console.log(`   Created version ${version}`);
  } catch {
    console.log("   Version may already exist, looking for it...");
    const versionsRes = await api(
      `/apps/${appId}/appStoreVersions?filter[versionString]=${version}&filter[platform]=${platform}`,
    );
    appStoreVersion = versionsRes.data[0];
    if (!appStoreVersion) {
      console.log(`⚠️  Could not create or find ${platformLabel} version ${version}, skipping.`);
      return;
    }
    console.log(`   Found existing version ${version}`);
  }

  // 3. Select the build
  console.log("🔗 Selecting build for version...");
  await api(`/appStoreVersions/${appStoreVersion.id}/relationships/build`, {
    method: "PATCH",
    body: JSON.stringify({
      data: { type: "builds", id: build.id },
    }),
  });
  console.log("   Build selected");

  // 4. Submit for review
  console.log("📤 Submitting for review...");
  try {
    await api("/appStoreVersionSubmissions", {
      method: "POST",
      body: JSON.stringify({
        data: {
          type: "appStoreVersionSubmissions",
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: appStoreVersion.id },
            },
          },
        },
      }),
    });
    console.log(`✅ ${platformLabel} version ${version} submitted for review!`);
  } catch (err: any) {
    if (err.message?.includes("403")) {
      console.log(`ℹ️  ${platformLabel} version ${version} is already submitted for review.`);
    } else {
      throw err;
    }
  }
}

// ── Main Flow ────────────────────────────────────────────────────────
async function main() {
  console.log(`🚀 Submitting version ${version} to App Store Review...\n`);

  // Find the app
  console.log("📱 Finding app...");
  const appsRes = await api(`/apps?filter[bundleId]=${APP_BUNDLE_ID}`);
  const app = appsRes.data[0];
  if (!app) throw new Error(`App not found with bundle ID: ${APP_BUNDLE_ID}`);
  const appId = app.id;
  console.log(`   Found: ${app.attributes.name} (${appId})`);

  // Submit both platforms
  await submitPlatform(appId, "IOS");
  await submitPlatform(appId, "MAC_OS");

  console.log("\n🎉 Done! Track review status at https://appstoreconnect.apple.com");
}

main().catch((err) => {
  console.error("\n❌ Failed to submit for review:", err.message);
  process.exit(1);
});
