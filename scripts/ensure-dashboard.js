import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

if (!existsSync("dist-dashboard/index.html")) {
  console.log("dashboard build missing — building...");
  execSync("npm run dashboard:build", { stdio: "inherit" });
}
