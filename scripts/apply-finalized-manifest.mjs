#!/usr/bin/env node

import {
  applyFinalizedEnvironmentFile,
  cliPathOption,
  readSecureJSONFile,
  validateFinalizedEnvironment,
} from "./lib/operator-artifacts.mjs";

const manifestFile = cliPathOption(process.argv, "--manifest-file", {
  required: true,
});
const environmentFile = cliPathOption(process.argv, "--env-file", {
  required: true,
});
const manifest = readSecureJSONFile(
  manifestFile,
  "finalized deployment manifest",
);
const releaseEnvironment = validateFinalizedEnvironment(
  manifest.applicationEnvironment,
);

applyFinalizedEnvironmentFile(environmentFile, releaseEnvironment);
console.log(
  `Applied ${Object.keys(releaseEnvironment).length} finalized release values to ${environmentFile}.`,
);
console.log(
  "No secret, database, compliance-service, finality, or gateway credential value was changed.",
);
