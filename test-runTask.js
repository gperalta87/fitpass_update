// Test script for runTask.js
import { runTask } from "./src/runTask.js";

// You can override defaults here if needed
const testOptions = {
  // email: "hola@pontepila.com",      // default
  // password: "fitpass2025",           // default
  // targetDate: "2025-10-31",         // default
  // targetTime: "08:00",              // default
  // targetName: "",                   // default
  // newCapacity: 2,                   // default
  debug: true,  // Enable debug output
};

console.log("🚀 Starting runTask test...");
console.log("Options:", testOptions);

runTask(testOptions)
  .then((result) => {
    console.log("\n✅ Success!");
    console.log(result);
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n❌ Error:", error.message);
    console.error(error.stack);
    process.exit(1);
  });

