import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get version from command line argument or package.json
const version = process.argv[2] || JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
const isPrerelease = process.argv[3] === 'true';

// The actual CFBundleVersion baked into the IPA (a date-based build number such as
// 2026062201, set by update-xcode-version.ts). AltStore 2.0+ verifies the source's
// buildVersion against the app's real CFBundleVersion, so this must match exactly —
// using the marketing version here causes "does not match the build number" install
// failures. Falls back to the marketing version only when not provided (e.g. local runs).
const buildVersion = process.argv[4] || version;

console.log(`Updating AltStore source for version: ${version}`);
console.log(`Is prerelease: ${isPrerelease}`);
console.log(`Build version (CFBundleVersion): ${buildVersion}`);

// Read the current source file
const sourceFilePath = path.join(__dirname, '..', 'Autodarts_Tools_Source.json');

if (!fs.existsSync(sourceFilePath)) {
  console.error('Autodarts_Tools_Source.json not found');
  process.exit(1);
}

const sourceData = JSON.parse(fs.readFileSync(sourceFilePath, 'utf8'));

// Get current date in ISO format
const currentDate = new Date().toISOString();

// Find the app in the source
const appIndex = sourceData.apps.findIndex(app => app.bundleIdentifier === 'com.boltapi.autodarts-tools');

if (appIndex === -1) {
  console.error('App not found in source file');
  process.exit(1);
}

// Try to get the actual IPA file size
let ipaSize = 31400000; // Default size
const ipaPath = path.join(__dirname, '..', '.output', 'autodarts-tools-ios.ipa');

if (fs.existsSync(ipaPath)) {
  try {
    const stats = fs.statSync(ipaPath);
    ipaSize = stats.size;
    console.log(`Found IPA file with size: ${ipaSize} bytes`);
  } catch (error) {
    console.warn(`Could not get IPA file size, using default: ${error.message}`);
  }
} else {
  console.warn('IPA file not found, using default size');
}

// Check if this version already exists
const existingVersionIndex = sourceData.apps[appIndex].versions.findIndex(v => v.version === version);

if (existingVersionIndex !== -1) {
  console.log(`Version ${version} already exists, updating it...`);
  // Update existing version
  sourceData.apps[appIndex].versions[existingVersionIndex] = {
    ...sourceData.apps[appIndex].versions[existingVersionIndex],
    date: currentDate,
    size: ipaSize,
    buildVersion: buildVersion
  };
} else {
  // Add new version to the beginning of the versions array
  const newVersion = {
    version: version,
    date: currentDate,
    localizedDescription: null,
    downloadURL: "https://github.com/creazy231/tools-for-autodarts/releases/latest/download/autodarts-tools-ios.ipa",
    size: ipaSize,
    buildVersion: buildVersion,
    minOSVersion: "15.6"
  };

  // Insert new version at the beginning
  sourceData.apps[appIndex].versions.unshift(newVersion);
  console.log(`Added new version ${version}`);
}

// Keep only the last 5 versions to avoid the file getting too large
sourceData.apps[appIndex].versions = sourceData.apps[appIndex].versions.slice(0, 5);

// Create news entry
const newsTitle = isPrerelease ? 
  `Tools for Autodarts ${version} (Pre-release) Available!` : 
  `Tools for Autodarts ${version} Available!`;

const newsCaption = isPrerelease ?
  `Pre-release version ${version} is now available with the latest features and improvements.` :
  `Version ${version} is now available with new features and improvements.`;

// Check if news entry for this version already exists
const existingNewsIndex = sourceData.news.findIndex(news => 
  news.title.includes(version) || news.identifier.includes(version.replace(/\./g, '_'))
);

if (existingNewsIndex === -1) {
  const newNewsEntry = {
    title: newsTitle,
    identifier: `news_${version.replace(/\./g, '_')}_${Date.now()}`,
    caption: newsCaption,
    date: currentDate,
    tintColor: "#6156e2",
    notify: !isPrerelease, // Don't notify for pre-releases
    url: "https://github.com/creazy231/tools-for-autodarts",
    appID: "com.boltapi.autodarts-tools"
  };

  // Add news entry to the beginning
  sourceData.news.unshift(newNewsEntry);
  console.log(`Added news entry for version ${version}`);
} else {
  console.log(`News entry for version ${version} already exists, skipping...`);
}

// Keep only the last 10 news entries
sourceData.news = sourceData.news.slice(0, 10);

// Write the updated source file
try {
  fs.writeFileSync(sourceFilePath, JSON.stringify(sourceData, null, 2));
  console.log(`Successfully updated AltStore source with version ${version}`);
  console.log(`File size: ${ipaSize} bytes`);
} catch (error) {
  console.error(`Failed to write source file: ${error.message}`);
  process.exit(1);
} 