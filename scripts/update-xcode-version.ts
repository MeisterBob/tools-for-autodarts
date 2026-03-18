import fs from "node:fs";
import path from "node:path";

// Get version from package.json
const packageJsonPath = path.join(__dirname, "..", "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
const version = packageJson.version;

console.log(`Updating Xcode project to version ${version}`);

// Read the Xcode project file
const pbxprojPath = path.join(__dirname, "..", "Tools for Autodarts", "Tools for Autodarts.xcodeproj", "project.pbxproj");
let pbxprojContent = fs.readFileSync(pbxprojPath, "utf-8");

// Update all MARKETING_VERSION entries
const marketingVersionRegex = /MARKETING_VERSION = [^;]+;/g;
pbxprojContent = pbxprojContent.replace(marketingVersionRegex, `MARKETING_VERSION = ${version};`);

// Update all CURRENT_PROJECT_VERSION entries to a numeric build number
// Convert semver to integer: 2.2.7 → 20207 (major*10000 + minor*100 + patch)
const [major, minor, patch] = version.split(".").map(Number);
const buildNumber = major * 10000 + minor * 100 + patch;
const currentProjectVersionRegex = /CURRENT_PROJECT_VERSION = [^;]+;/g;
pbxprojContent = pbxprojContent.replace(currentProjectVersionRegex, `CURRENT_PROJECT_VERSION = ${buildNumber};`);

// Write back the updated content
fs.writeFileSync(pbxprojPath, pbxprojContent);

console.log(`✅ Updated Xcode project MARKETING_VERSION to ${version}`);
console.log(`✅ Updated Xcode project CURRENT_PROJECT_VERSION to ${buildNumber}`);
