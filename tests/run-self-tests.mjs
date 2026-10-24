import { runSelfTests } from "../js/self-tests.js";

const results = await runSelfTests();
let failures = 0;

for (const result of results) {
  const status = result.status.padEnd(4);
  console.log(`${status} ${result.name}: ${result.reason}`);
  if (result.status !== "PASS") failures += 1;
}

console.log(`\n${results.length - failures}/${results.length} tests passed.`);
if (failures > 0) process.exitCode = 1;
